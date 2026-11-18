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
import { AIResult, IAIMessageRequest } from '../../common/ai.js';
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
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
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
});
`;

function request(prompt: string, overrides: Partial<IAIMessageRequest> = {}): IAIMessageRequest {
	return { threadId: 'thread-1', providerId: CLAUDE_CLI_PROVIDER_ID, mode: 'ask', prompt, ...overrides };
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
		const texts: string[] = [];
		await adapter.run(request(prompt, overrides), text => texts.push(text), token);
		return texts;
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

	test('refuses agent and debug mode', async () => {
		assert.deepStrictEqual([...adapter.supportedModes], ['ask', 'plan']);
		assert.throws(() => buildClaudeCliArgs(request('p', { mode: 'agent' })));
		assert.throws(() => buildClaudeCliArgs(request('p', { mode: 'debug' })));
		await assert.rejects(collect('args', { mode: 'agent' }));
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
		await assert.rejects(missing.run(request('success'), () => { }, CancellationToken.None), /Could not start the Claude CLI/);
	});

	test('cancellation stops the process', async () => {
		const source = store.add(new CancellationTokenSource());
		const texts: string[] = [];
		const run = adapter.run(request('hang'), text => {
			texts.push(text);
			source.cancel();
		}, source.token);

		await assert.rejects(run, error => isCancellationError(error));
		assert.deepStrictEqual(texts, ['started']);
	});

	test('cancellation kills a process that ignores SIGTERM after the grace period', async () => {
		const source = store.add(new CancellationTokenSource());
		const run = adapter.run(request('ignore-term'), () => source.cancel(), source.token);
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

		let read = unwrap(await service.readStream(streamId, 0));
		for (let i = 0; !read.done && i < 200; i++) {
			await timeout(25);
			read = unwrap(await service.readStream(streamId, 0));
		}

		assert.deepStrictEqual(read.chunks, [
			{ kind: 'text', cursor: 0, text: 'Hello ' },
			{ kind: 'text', cursor: 1, text: 'world' },
			{ kind: 'end', cursor: 2, reason: 'completed' },
		]);
		assert.strictEqual((await service.sendMessage(request('p', { mode: 'agent' }))).ok, false);
	});
});
