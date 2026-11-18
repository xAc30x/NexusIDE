/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NexusIDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import { promises as fs } from 'fs';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { CancellationError } from '../../../base/common/errors.js';
import { AIExecutionMode, IAIMessageRequest } from '../common/ai.js';
import { IAIProviderAdapter, IAIRunSink } from '../common/aiProvider.js';
import { ClaudeStreamEvent, ClaudeStreamParser, describeToolUse, LineBuffer } from '../common/claudeStreamParser.js';

export const CLAUDE_CLI_PROVIDER_ID = 'claude-cli';

/** Time a cancelled `claude` process gets to exit after SIGTERM before it is killed. */
const DEFAULT_KILL_GRACE_MS = 5_000;

/** Time `claude --version` may take before the CLI is treated as unavailable. */
const DEFAULT_AVAILABILITY_TIMEOUT_MS = 5_000;

/** Amount of stderr output kept for error messages. */
const MAX_STDERR_LENGTH = 4_000;

/** Built-in Claude Code tools that only read. They never need approval. */
const READ_ONLY_TOOLS = 'Read,Grep,Glob';

/**
 * Tools available in Agent mode. Tools outside {@link READ_ONLY_TOOLS} are
 * approved one call at a time by the user.
 */
const AGENT_TOOLS = 'Read,Grep,Glob,Edit,Write,Bash';

/** Modes the adapter accepts. Debug mode is not supported yet. */
const SUPPORTED_MODES: readonly AIExecutionMode[] = ['ask', 'plan', 'agent'];

/** Message returned to the CLI when the user denies a tool call. */
const DENIED_MESSAGE = 'The user denied this action.';

/**
 * Accepted model names, for example `opus` or `claude-sonnet-4-5`. A name must
 * not start with `-`, so it can never be read as another CLI option.
 */
const MODEL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:\[\]-]*$/;

export interface IClaudeCliAdapterOptions {
	/** Executable to start. Defaults to `claude` found on the PATH. */
	readonly command?: string;
	/** Arguments placed before the adapter's own arguments, for example a script path. */
	readonly commandArgs?: readonly string[];
	/** Environment for the CLI process. Defaults to the environment of this process. */
	readonly env?: NodeJS.ProcessEnv;
	readonly killGraceMs?: number;
	readonly availabilityTimeoutMs?: number;
}

/**
 * Builds the CLI arguments for a request. The prompt is not part of the
 * arguments: it is written to stdin so its length and characters cannot
 * affect argument parsing. In Agent mode stdin also carries the answers to
 * permission requests.
 */
export function buildClaudeCliArgs(request: IAIMessageRequest): string[] {
	const args = [
		'-p',
		'--output-format', 'stream-json',
		'--include-partial-messages',
		'--verbose',
		'--no-session-persistence',
	];
	switch (request.mode) {
		case 'ask':
			// Deny every tool use that is not pre-approved instead of prompting.
			args.push('--tools', READ_ONLY_TOOLS, '--permission-mode', 'dontAsk');
			break;
		case 'plan':
			args.push('--tools', READ_ONLY_TOOLS, '--permission-mode', 'plan');
			break;
		case 'agent':
			// Tool calls that are not pre-approved are sent to us as control
			// requests on stdout and answered on stdin, so the prompt is sent as a
			// stream-json message. --restricted keeps file tools inside the working
			// directory and ignores user and project settings, so no settings file
			// can pre-approve tools behind the user's back.
			args.push(
				'--input-format', 'stream-json',
				'--permission-prompt-tool', 'stdio',
				'--restricted',
				'--tools', AGENT_TOOLS,
				'--allowedTools', READ_ONLY_TOOLS,
			);
			break;
		default:
			throw new Error(`Claude CLI does not support ${request.mode} mode yet.`);
	}
	if (request.model !== undefined) {
		if (!MODEL_NAME_PATTERN.test(request.model)) {
			throw new Error(`Invalid model name: ${request.model}`);
		}
		args.push('--model', request.model);
	}
	return args;
}

/**
 * Runs requests through the local Claude Code CLI (`claude -p`) and streams
 * the reply from its `stream-json` output.
 *
 * The process is started without a shell. On Windows this means a `claude`
 * installed as a `.cmd` shim is not found; the native `claude.exe` works.
 */
export class ClaudeCliAdapter implements IAIProviderAdapter {

	readonly id = CLAUDE_CLI_PROVIDER_ID;
	readonly displayName = 'Claude Code CLI';
	readonly kind = 'cli' as const;
	readonly supportedModes = SUPPORTED_MODES;

	private readonly command: string;
	private readonly commandArgs: readonly string[];
	private readonly env: NodeJS.ProcessEnv | undefined;
	private readonly killGraceMs: number;
	private readonly availabilityTimeoutMs: number;

	constructor(options: IClaudeCliAdapterOptions = {}) {
		this.command = options.command ?? 'claude';
		this.commandArgs = options.commandArgs ?? [];
		this.env = options.env;
		this.killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
		this.availabilityTimeoutMs = options.availabilityTimeoutMs ?? DEFAULT_AVAILABILITY_TIMEOUT_MS;
	}

	isAvailable(): Promise<boolean> {
		return new Promise(resolve => {
			let settled = false;
			const settle = (available: boolean) => {
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					resolve(available);
				}
			};

			const child = cp.spawn(this.command, [...this.commandArgs, '--version'], { env: this.env, stdio: 'ignore', shell: false, windowsHide: true });
			const timer = setTimeout(() => {
				child.kill('SIGKILL');
				settle(false);
			}, this.availabilityTimeoutMs);
			child.once('error', () => settle(false));
			child.once('exit', code => settle(code === 0));
		});
	}

	async run(request: IAIMessageRequest, sink: IAIRunSink, token: CancellationToken): Promise<void> {
		const args = buildClaudeCliArgs(request);
		if (request.mode === 'agent' && request.workingDirectory === undefined) {
			// Without a folder the CLI would edit files and run commands in the
			// folder NexusIDE itself was started from.
			throw new Error('Agent mode needs an open folder to work in.');
		}
		if (request.workingDirectory !== undefined) {
			await assertDirectory(request.workingDirectory);
		}
		if (token.isCancellationRequested) {
			throw new CancellationError();
		}

		await new Promise<void>((resolve, reject) => {
			const parser = new ClaudeStreamParser();
			const lines = new LineBuffer();
			let resultError: string | undefined;
			let sawResult = false;
			let stderr = '';
			let killTimer: ReturnType<typeof setTimeout> | undefined;
			const interactive = request.mode === 'agent';
			let stdinOpen = true;

			const child = cp.spawn(this.command, [...this.commandArgs, ...args], {
				cwd: request.workingDirectory,
				env: this.env,
				stdio: ['pipe', 'pipe', 'pipe'],
				shell: false,
				windowsHide: true,
			});

			const closeStdin = () => {
				if (stdinOpen) {
					stdinOpen = false;
					child.stdin.end();
				}
			};

			/** Writes one stream-json line to the CLI. Dropped once stdin is closed. */
			const writeLine = (message: object) => {
				if (stdinOpen) {
					child.stdin.write(JSON.stringify(message) + '\n', 'utf8');
				}
			};

			const handleEvent = (event: ClaudeStreamEvent) => {
				switch (event.kind) {
					case 'text':
						sink.text(event.text);
						break;
					case 'toolResult':
						sink.toolUse(describeToolUse(event.toolName, event.input, request.workingDirectory).summary, event.isError);
						break;
					case 'permission': {
						const { summary, detail } = describeToolUse(event.toolName, event.input, request.workingDirectory);
						void sink.requestPermission({ toolName: event.toolName, summary, ...(detail !== undefined ? { detail } : {}) }).then(decision => {
							const response = decision === 'allow'
								? { behavior: 'allow', updatedInput: event.input }
								: { behavior: 'deny', message: DENIED_MESSAGE };
							writeLine({ type: 'control_response', response: { subtype: 'success', request_id: event.requestId, response } });
						});
						break;
					}
					case 'unsupportedControl':
						writeLine({ type: 'control_response', response: { subtype: 'error', request_id: event.requestId, error: `Unsupported control request: ${event.subtype}` } });
						break;
					case 'result':
						sawResult = true;
						resultError = event.isError ? event.errorMessage : undefined;
						// The CLI waits for more input until stdin closes.
						closeStdin();
						break;
				}
			};

			const handleLines = (completed: string[]) => {
				for (const line of completed) {
					for (const event of parser.parseLine(line)) {
						handleEvent(event);
					}
				}
			};

			const cancelListener = token.onCancellationRequested(() => {
				child.kill('SIGTERM');
				killTimer = setTimeout(() => child.kill('SIGKILL'), this.killGraceMs);
			});

			const cleanUp = () => {
				cancelListener.dispose();
				if (killTimer !== undefined) {
					clearTimeout(killTimer);
				}
			};

			child.stdout.setEncoding('utf8');
			child.stdout.on('data', (chunk: string) => handleLines(lines.push(chunk)));
			child.stderr.setEncoding('utf8');
			child.stderr.on('data', (chunk: string) => {
				stderr = (stderr + chunk).slice(-MAX_STDERR_LENGTH);
			});
			// The process may exit before reading stdin; that is reported through 'close'.
			child.stdin.on('error', () => { stdinOpen = false; });
			if (interactive) {
				writeLine({ type: 'user', message: { role: 'user', content: request.prompt } });
			} else {
				stdinOpen = false;
				child.stdin.end(request.prompt, 'utf8');
			}

			child.once('error', error => {
				cleanUp();
				reject(new Error(`Could not start the Claude CLI (${this.command}): ${error.message}`));
			});

			child.once('close', (code, signal) => {
				cleanUp();
				handleLines(lines.flush());
				stdinOpen = false;

				if (token.isCancellationRequested) {
					reject(new CancellationError());
				} else if (resultError !== undefined) {
					reject(new Error(resultError));
				} else if (code !== 0) {
					const reason = signal ? `was stopped by ${signal}` : `exited with code ${code}`;
					reject(new Error(`Claude CLI ${reason}.${formatStderr(stderr)}`));
				} else if (!sawResult) {
					reject(new Error(`Claude CLI exited without a result.${formatStderr(stderr)}`));
				} else {
					resolve();
				}
			});
		});
	}
}

async function assertDirectory(path: string): Promise<void> {
	let isDirectory = false;
	try {
		isDirectory = (await fs.stat(path)).isDirectory();
	} catch {
		// reported below
	}
	if (!isDirectory) {
		throw new Error(`Working directory does not exist or is not a folder: ${path}`);
	}
}

function formatStderr(stderr: string): string {
	const trimmed = stderr.trim();
	return trimmed.length > 0 ? `\n${trimmed}` : '';
}
