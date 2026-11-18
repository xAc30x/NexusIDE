/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NexusIDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import { promises as fs } from 'fs';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { CancellationError } from '../../../base/common/errors.js';
import { AIExecutionMode, IAIMessageRequest } from '../common/ai.js';
import { IAIProviderAdapter } from '../common/aiProvider.js';
import { ClaudeStreamParser, LineBuffer } from '../common/claudeStreamParser.js';

export const CLAUDE_CLI_PROVIDER_ID = 'claude-cli';

/** Time a cancelled `claude` process gets to exit after SIGTERM before it is killed. */
const DEFAULT_KILL_GRACE_MS = 5_000;

/** Time `claude --version` may take before the CLI is treated as unavailable. */
const DEFAULT_AVAILABILITY_TIMEOUT_MS = 5_000;

/** Amount of stderr output kept for error messages. */
const MAX_STDERR_LENGTH = 4_000;

/**
 * Built-in Claude Code tools the CLI may use. Only read-only tools are allowed
 * until the workbench can ask the user to approve edits and commands.
 */
const READ_ONLY_TOOLS = 'Read,Grep,Glob';

/**
 * Modes the adapter accepts. Agent and Debug need file edits and command
 * execution, which stay disabled until an approval UI exists.
 */
const SUPPORTED_MODES: readonly AIExecutionMode[] = ['ask', 'plan'];

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
	readonly killGraceMs?: number;
	readonly availabilityTimeoutMs?: number;
}

/**
 * Builds the CLI arguments for a request. The prompt is not part of the
 * arguments: it is written to stdin so its length and characters cannot
 * affect argument parsing.
 */
export function buildClaudeCliArgs(request: IAIMessageRequest): string[] {
	const args = [
		'-p',
		'--output-format', 'stream-json',
		'--include-partial-messages',
		'--verbose',
		'--no-session-persistence',
		'--tools', READ_ONLY_TOOLS,
	];
	switch (request.mode) {
		case 'ask':
			// Deny every tool use that is not pre-approved instead of prompting.
			args.push('--permission-mode', 'dontAsk');
			break;
		case 'plan':
			args.push('--permission-mode', 'plan');
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
	private readonly killGraceMs: number;
	private readonly availabilityTimeoutMs: number;

	constructor(options: IClaudeCliAdapterOptions = {}) {
		this.command = options.command ?? 'claude';
		this.commandArgs = options.commandArgs ?? [];
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

			const child = cp.spawn(this.command, [...this.commandArgs, '--version'], { stdio: 'ignore', shell: false, windowsHide: true });
			const timer = setTimeout(() => {
				child.kill('SIGKILL');
				settle(false);
			}, this.availabilityTimeoutMs);
			child.once('error', () => settle(false));
			child.once('exit', code => settle(code === 0));
		});
	}

	async run(request: IAIMessageRequest, onText: (text: string) => void, token: CancellationToken): Promise<void> {
		const args = buildClaudeCliArgs(request);
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

			const child = cp.spawn(this.command, [...this.commandArgs, ...args], {
				cwd: request.workingDirectory,
				stdio: ['pipe', 'pipe', 'pipe'],
				shell: false,
				windowsHide: true,
			});

			const handleLines = (completed: string[]) => {
				for (const line of completed) {
					for (const event of parser.parseLine(line)) {
						if (event.kind === 'text') {
							onText(event.text);
						} else {
							sawResult = true;
							resultError = event.isError ? event.errorMessage : undefined;
						}
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
			child.stdin.on('error', () => { });
			child.stdin.end(request.prompt, 'utf8');

			child.once('error', error => {
				cleanUp();
				reject(new Error(`Could not start the Claude CLI (${this.command}): ${error.message}`));
			});

			child.once('close', (code, signal) => {
				cleanUp();
				handleLines(lines.flush());

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
