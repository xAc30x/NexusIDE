/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NexusIDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { timeout } from '../../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { getRandomTestPath } from '../../../../base/test/node/testUtils.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { AIPermissionDecision, AIResult, AIStreamChunk, IAIMessageRequest } from '../../common/ai.js';
import { IAIPermissionRequest, IAIRunSink } from '../../common/aiProvider.js';
import { AIService } from '../../common/aiService.js';
import { buildClaudeCliArgs, CLAUDE_CLI_PROVIDER_ID, ClaudeCliAdapter, IClaudeCliAdapterOptions } from '../../node/claudeCliAdapter.js';

/**
 * Stand-in for the `claude` CLI. The prompt read from stdin selects what it
 * prints, so tests never call a real AI backend.
 */
const FAKE_CLAUDE_SCRIPT = `
const args = process.argv.slice(2);
if (args.includes('--version')) {
	process.stdout.write('9.9.9 (fake)\\n');
	process.exit(0);
}
const out = value => process.stdout.write(JSON.stringify(value) + '\\n');
const delta = text => out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
const success = () => out({ type: 'result', subtype: 'success', is_error: false, result: '' });
let input = '';
process.stdin.setEncoding('utf8');
if (args.includes('--input-format')) {
	runAgent();
} else {
	process.stdin.on('data', chunk => input += chunk);
	process.stdin.on('end', runPrint);
}

// Agent mode: stdin carries stream-json lines and stays open until the host
// closes it after the result.
function runAgent() {
	let buffer = '';
	let onResponse;
	process.stdin.on('data', chunk => {
		buffer += chunk;
		const lines = buffer.split('\\n');
		buffer = lines.pop();
		for (const line of lines.filter(l => l.trim())) {
			const message = JSON.parse(line);
			if (message.type === 'user') {
				startAgentScenario(message.message.content, response => onResponse = response);
			} else if (message.type === 'control_response') {
				onResponse(message.response);
			}
		}
	});
	process.stdin.on('end', () => process.exit(0));
}

function startAgentScenario(prompt, setOnResponse) {
	switch (prompt) {
		case 'write': {
			const input = { file_path: 'hello.txt', content: 'hi' };
			out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Write', input }] } });
			setOnResponse(response => {
				const allowed = response.response.behavior === 'allow';
				if (allowed) {
					require('fs').writeFileSync(response.response.updatedInput.file_path, response.response.updatedInput.content);
				}
				out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', is_error: !allowed }] } });
				delta(allowed ? 'written' : 'skipped: ' + response.response.message);
				success();
			});
			out({ type: 'control_request', request_id: 'req-1', request: { subtype: 'can_use_tool', tool_name: 'Write', input } });
			return;
		}
		case 'unknown-control':
			setOnResponse(response => {
				delta(response.subtype + ': ' + response.error);
				success();
			});
			out({ type: 'control_request', request_id: 'req-2', request: { subtype: 'mystery' } });
			return;
		default:
			process.stderr.write('unknown agent scenario: ' + prompt);
			process.exit(3);
	}
}

function runPrint() {
	if (input.startsWith('echo:')) {
		delta(input.slice('echo:'.length));
		success();
		return;
	}
	switch (input) {
		case 'success': {
			out({ type: 'system', subtype: 'init' });
			out({ type: 'stream_event', event: { type: 'message_start', message: {} } });
			const line = JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello ' } } }) + '\\n';
			process.stdout.write(line.slice(0, 10));
			setTimeout(() => {
				process.stdout.write(line.slice(10));
				delta('world');
				out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello world' }] } });
				success();
			}, 20);
			return;
		}
		case 'args':
			delta(JSON.stringify({ args, cwd: process.cwd() }));
			success();
			return;
		case 'error-result':
			out({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom'] });
			process.exitCode = 1;
			return;
		case 'crash':
			process.stderr.write('fatal problem\\n');
			process.exitCode = 2;
			return;
		case 'no-result':
			delta('partial');
			return;
		case 'hang':
			delta('started');
			setInterval(() => { }, 1000);
			return;
		case 'ignore-term':
			process.on('SIGTERM', () => { });
			delta('started');
			setInterval(() => { }, 1000);
			return;
		default:
			process.stderr.write('unknown scenario: ' + input);
			process.exitCode = 3;
	}
}
`;

function request(prompt: string, overrides: Partial<IAIMessageRequest> = {}): IAIMessageRequest {
	return { threadId: 'thread-1', providerId: CLAUDE_CLI_PROVIDER_ID, mode: 'ask', prompt, ...overrides };
}

/** Output of a run as recorded by {@link RecordingSink}. */
/** Tool summaries are left out: they are covered by the describeToolUse tests. */
type Recorded =
	| { readonly kind: 'text'; readonly text: string }
	| { readonly kind: 'tool'; readonly failed: boolean }
	| { readonly kind: 'permission'; readonly toolName: string };

/**
 * Records everything an adapter reports. Permission requests are answered by
 * `decide`, which defaults to never answering.
 */
class RecordingSink implements IAIRunSink {
	readonly output: Recorded[] = [];

	constructor(
		private readonly onText: (text: string) => void = () => { },
		private readonly decide: (request: IAIPermissionRequest) => Promise<AIPermissionDecision> = () => new Promise(() => { }),
	) { }

	get texts(): string[] {
		return this.output.flatMap(entry => entry.kind === 'text' ? [entry.text] : []);
	}

	text(text: string): void {
		this.output.push({ kind: 'text', text });
		this.onText(text);
	}

	toolUse(_summary: string, failed: boolean): void {
		this.output.push({ kind: 'tool', failed });
	}

	requestPermission(request: IAIPermissionRequest): Promise<AIPermissionDecision> {
		this.output.push({ kind: 'permission', toolName: request.toolName });
		return this.decide(request);
	}
}

function unwrap<T>(result: AIResult<T>): T {
	if (!result.ok) {
		assert.fail(`Expected ok result, got error: ${result.error}`);
	}
	return result.value;
}

/**
 * Options that run a script with the current executable. In the Electron test
 * runner that executable is Electron, which only acts as Node when
 * ELECTRON_RUN_AS_NODE is set.
 */
function nodeScript(script: string): IClaudeCliAdapterOptions {
	return { command: process.execPath, commandArgs: [script], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } };
}

suite('ClaudeCliAdapter', function () {

	this.timeout(20_000);

	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let testDir: string;
	let adapter: ClaudeCliAdapter;

	setup(async () => {
		testDir = getRandomTestPath(tmpdir(), 'nexuside', 'claudeCliAdapter');
		await fs.mkdir(testDir, { recursive: true });
		const script = join(testDir, 'fake-claude.cjs');
		await fs.writeFile(script, FAKE_CLAUDE_SCRIPT);
		adapter = new ClaudeCliAdapter({ ...nodeScript(script), killGraceMs: 200 });
	});

	teardown(async () => {
		await fs.rm(testDir, { recursive: true, force: true });
	});

	async function collect(prompt: string, overrides: Partial<IAIMessageRequest> = {}, token: CancellationToken = CancellationToken.None): Promise<string[]> {
		const sink = new RecordingSink();
		await adapter.run(request(prompt, overrides), sink, token);
		return sink.texts;
	}

	async function readUntil(service: AIService, streamId: string, until: (chunks: readonly AIStreamChunk[]) => boolean): Promise<readonly AIStreamChunk[]> {
		for (let i = 0; i < 400; i++) {
			const read = unwrap(await service.readStream(streamId, 0));
			if (read.done || until(read.chunks)) {
				return read.chunks;
			}
			await timeout(25);
		}
		assert.fail('Stream did not reach the expected state.');
	}

	test('builds read-only arguments for ask and plan mode', () => {
		const ask = buildClaudeCliArgs(request('secret prompt'));
		assert.deepStrictEqual(ask.slice(0, 9), ['-p', '--output-format', 'stream-json', '--include-partial-messages', '--verbose', '--no-session-persistence', '--tools', 'Read,Grep,Glob', '--permission-mode']);
		assert.strictEqual(ask[9], 'dontAsk');
		assert.ok(!ask.includes('secret prompt'));

		const plan = buildClaudeCliArgs(request('p', { mode: 'plan', model: 'opus' }));
		assert.deepStrictEqual(plan.slice(-4), ['--permission-mode', 'plan', '--model', 'opus']);
	});

	test('refuses model names that could be read as CLI options', () => {
		assert.deepStrictEqual(buildClaudeCliArgs(request('p', { model: 'claude-sonnet-4-5[1m]' })).slice(-2), ['--model', 'claude-sonnet-4-5[1m]']);
		assert.throws(() => buildClaudeCliArgs(request('p', { model: '--dangerously-skip-permissions' })));
		assert.throws(() => buildClaudeCliArgs(request('p', { model: 'opus --tools Bash' })));
	});

	test('builds agent arguments that send tool approvals to the host', () => {
		assert.deepStrictEqual(buildClaudeCliArgs(request('p', { mode: 'agent' })).slice(6), [
			'--input-format', 'stream-json',
			'--permission-prompt-tool', 'stdio',
			'--restricted',
			'--tools', 'Read,Grep,Glob,Edit,Write,Bash',
			'--allowedTools', 'Read,Grep,Glob',
		]);
	});

	test('builds debug arguments: the agent approval flow plus debugging instructions', () => {
		assert.deepStrictEqual([...adapter.supportedModes], ['ask', 'plan', 'agent', 'debug']);
		const agent = buildClaudeCliArgs(request('secret prompt', { mode: 'agent' }));
		const debug = buildClaudeCliArgs(request('secret prompt', { mode: 'debug' }));
		assert.deepStrictEqual(debug.slice(0, agent.length), agent);
		assert.deepStrictEqual(debug.slice(agent.length, agent.length + 1), ['--append-system-prompt']);
		const instructions = debug[agent.length + 1];
		assert.ok(instructions.includes('Root cause') && instructions.includes('<problems>'), instructions);
		assert.strictEqual(debug.length, agent.length + 2);
		assert.ok(!debug.some(arg => arg.includes('secret prompt')), 'the prompt is never an argument');
	});

	test('debug mode asks for approval before each tool, like agent mode', async () => {
		const outputs: unknown[] = [];
		for (const decision of ['deny', 'allow'] as const) {
			const sink = new RecordingSink(undefined, async () => decision);
			await adapter.run(request('write', { mode: 'debug', workingDirectory: testDir }), sink, CancellationToken.None);
			outputs.push(sink.output);
		}
		assert.deepStrictEqual(outputs, [
			[{ kind: 'permission', toolName: 'Write' }, { kind: 'tool', failed: true }, { kind: 'text', text: 'skipped: The user denied this action.' }],
			[{ kind: 'permission', toolName: 'Write' }, { kind: 'tool', failed: false }, { kind: 'text', text: 'written' }],
		]);
		assert.strictEqual(await fs.readFile(join(testDir, 'hello.txt'), 'utf8'), 'hi');
	});

	test('agent mode runs an allowed tool and reports it', async () => {
		const sink = new RecordingSink(undefined, async () => 'allow');
		await adapter.run(request('write', { mode: 'agent', workingDirectory: testDir }), sink, CancellationToken.None);

		assert.deepStrictEqual(sink.output, [
			{ kind: 'permission', toolName: 'Write' },
			{ kind: 'tool', failed: false },
			{ kind: 'text', text: 'written' },
		]);
		assert.strictEqual(await fs.readFile(join(testDir, 'hello.txt'), 'utf8'), 'hi');
	});

	test('agent mode tells the CLI when the user denies a tool', async () => {
		const sink = new RecordingSink(undefined, async () => 'deny');
		await adapter.run(request('write', { mode: 'agent', workingDirectory: testDir }), sink, CancellationToken.None);

		assert.deepStrictEqual(sink.output, [
			{ kind: 'permission', toolName: 'Write' },
			{ kind: 'tool', failed: true },
			{ kind: 'text', text: 'skipped: The user denied this action.' },
		]);
		await assert.rejects(fs.access(join(testDir, 'hello.txt')));
	});

	test('agent mode answers unknown control requests with an error', async () => {
		assert.deepStrictEqual(await collect('unknown-control', { mode: 'agent', workingDirectory: testDir }), ['error: Unsupported control request: mystery']);
	});

	test('agent and debug mode refuse to run without a working directory', async () => {
		await assert.rejects(collect('write', { mode: 'agent' }), /Agent mode needs an open folder/);
		await assert.rejects(collect('write', { mode: 'debug' }), /Fix mode needs an open folder/);
	});

	test('cancellation stops an agent run that waits for approval', async () => {
		const source = store.add(new CancellationTokenSource());
		const sink = new RecordingSink(undefined, () => {
			source.cancel();
			return new Promise(() => { });
		});
		await assert.rejects(adapter.run(request('write', { mode: 'agent', workingDirectory: testDir }), sink, source.token), error => isCancellationError(error));
	});

	test('streams text from stream-json output, including lines split across chunks', async () => {
		assert.deepStrictEqual(await collect('success'), ['Hello ', 'world']);
	});

	test('passes the prompt through stdin unchanged', async () => {
		const prompt = 'quotes " \' $(echo nope) `ls` ; && | \n second line ✓ 漢字';
		assert.deepStrictEqual(await collect(`echo:${prompt}`), [prompt]);
	});

	test('starts the CLI with the built arguments in the working directory', async () => {
		const [output] = await collect('args', { mode: 'plan', workingDirectory: testDir });
		const { args, cwd } = JSON.parse(output);
		assert.deepStrictEqual(args, buildClaudeCliArgs(request('args', { mode: 'plan' })));
		assert.strictEqual(await fs.realpath(cwd), await fs.realpath(testDir));
	});

	test('rejects a working directory that does not exist', async () => {
		await assert.rejects(collect('args', { workingDirectory: join(testDir, 'missing') }), /does not exist/);
	});

	test('reports error results from the CLI', async () => {
		await assert.rejects(collect('error-result'), /boom/);
	});

	test('reports a non-zero exit code with stderr output', async () => {
		await assert.rejects(collect('crash'), (error: Error) => error.message.includes('exited with code 2') && error.message.includes('fatal problem'));
	});

	test('reports output that ends without a result', async () => {
		await assert.rejects(collect('no-result'), /without a result/);
	});

	test('reports a CLI that cannot be started', async () => {
		const missing = new ClaudeCliAdapter({ command: join(testDir, 'no-such-claude') });
		await assert.rejects(missing.run(request('success'), new RecordingSink(), CancellationToken.None), /Could not start the Claude CLI/);
	});

	test('cancellation stops the process', async () => {
		const source = store.add(new CancellationTokenSource());
		const sink = new RecordingSink(() => source.cancel());
		const run = adapter.run(request('hang'), sink, source.token);

		await assert.rejects(run, error => isCancellationError(error));
		assert.deepStrictEqual(sink.texts, ['started']);
	});

	test('cancellation kills a process that ignores SIGTERM after the grace period', async () => {
		const source = store.add(new CancellationTokenSource());
		const run = adapter.run(request('ignore-term'), new RecordingSink(() => source.cancel()), source.token);
		await assert.rejects(run, error => isCancellationError(error));
	});

	test('is available when --version succeeds and unavailable otherwise', async () => {
		assert.strictEqual(await adapter.isAvailable(), true);
		assert.strictEqual(await new ClaudeCliAdapter({ command: join(testDir, 'no-such-claude') }).isAvailable(), false);
		assert.strictEqual(await new ClaudeCliAdapter(nodeScript(join(testDir, 'missing-script.cjs'))).isAvailable(), false);
	});

	test('works end to end through AIService', async () => {
		const service = store.add(new AIService([adapter], new NullLogService()));
		const { streamId } = unwrap(await service.sendMessage(request('success')));

		assert.deepStrictEqual(await readUntil(service, streamId, () => false), [
			{ kind: 'text', cursor: 0, text: 'Hello ' },
			{ kind: 'text', cursor: 1, text: 'world' },
			{ kind: 'end', cursor: 2, reason: 'completed' },
		]);
	});

	test('routes an agent approval end to end through AIService', async () => {
		const service = store.add(new AIService([adapter], new NullLogService()));
		const { streamId } = unwrap(await service.sendMessage(request('write', { mode: 'agent', workingDirectory: testDir })));

		const before = await readUntil(service, streamId, chunks => chunks.some(chunk => chunk.kind === 'permission'));
		const permission = before.find(chunk => chunk.kind === 'permission');
		assert.ok(permission?.kind === 'permission');
		assert.deepStrictEqual(await service.respondToPermission('thread-1', permission.requestId, 'allow'), { ok: true, value: true });

		const chunks = await readUntil(service, streamId, () => false);
		assert.deepStrictEqual(chunks.map(chunk => chunk.kind), ['permission', 'permissionResolved', 'tool', 'text', 'end']);
		assert.deepStrictEqual(chunks.at(-1), { kind: 'end', cursor: 4, reason: 'completed' });
		assert.strictEqual(await fs.readFile(join(testDir, 'hello.txt'), 'utf8'), 'hi');
	});
});
