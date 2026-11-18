/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NexusIDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isAbsolute, relative } from '../../../base/common/path.js';

/**
 * Splits a stream of text chunks into complete lines. A line that arrives in
 * several chunks is returned once it is complete. Both `\n` and `\r\n` line
 * endings are accepted.
 */
export class LineBuffer {

	private partial = '';

	/** Adds a chunk and returns the lines it completed. */
	push(chunk: string): string[] {
		const text = this.partial + chunk;
		const lines = text.split('\n');
		this.partial = lines.pop() ?? '';
		return lines.map(stripCarriageReturn);
	}

	/** Returns the last line if the stream ended without a line break. */
	flush(): string[] {
		const rest = stripCarriageReturn(this.partial);
		this.partial = '';
		return rest.length > 0 ? [rest] : [];
	}
}

function stripCarriageReturn(line: string): string {
	return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/**
 * Events extracted from the `claude -p --output-format stream-json` output.
 */
export type ClaudeStreamEvent =
	| { readonly kind: 'text'; readonly text: string }
	/** A tool finished. `isError` is true when it failed or was denied. */
	| { readonly kind: 'toolResult'; readonly toolName: string; readonly input: ClaudeToolInput; readonly isError: boolean }
	/** The CLI asks the host whether a tool may run (`--permission-prompt-tool stdio`). */
	| { readonly kind: 'permission'; readonly requestId: string; readonly toolName: string; readonly input: ClaudeToolInput }
	/** A control request this parser does not understand. The host must still answer it. */
	| { readonly kind: 'unsupportedControl'; readonly requestId: string; readonly subtype: string }
	| { readonly kind: 'result'; readonly isError: boolean; readonly errorMessage?: string };

/** Input object of a Claude Code tool call, as sent by the CLI. */
export type ClaudeToolInput = Readonly<Record<string, unknown>>;

/**
 * Turns `stream-json` output lines of the Claude Code CLI into text, tool,
 * permission and result events.
 *
 * With `--include-partial-messages` the CLI sends text as `stream_event`
 * deltas and then repeats the whole message in an `assistant` line. Text from
 * an `assistant` line is therefore only used when no delta of that message was
 * seen, so text is never emitted twice. Lines that are not JSON or have an
 * unknown shape are ignored and counted in {@link ignoredLineCount}.
 *
 * Tool calls are reported once their `tool_result` arrives, so an event means
 * the tool ran (or failed or was denied), not just that the model asked for it.
 */
export class ClaudeStreamParser {

	private sawDeltaInCurrentMessage = false;
	private ignoredLines = 0;
	/** Tool calls seen in assistant messages that have no result yet, by tool use id. */
	private readonly openToolUses = new Map<string, { readonly toolName: string; readonly input: ClaudeToolInput }>();

	get ignoredLineCount(): number {
		return this.ignoredLines;
	}

	parseLine(line: string): ClaudeStreamEvent[] {
		if (line.trim().length === 0) {
			return [];
		}

		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch {
			this.ignoredLines++;
			return [];
		}
		if (!isRecord(message)) {
			this.ignoredLines++;
			return [];
		}

		switch (message.type) {
			case 'stream_event':
				return this.parseStreamEvent(message.event);
			case 'assistant':
				return this.parseAssistantMessage(message.message);
			case 'user':
				return this.parseToolResults(message.message);
			case 'control_request': {
				const event = parseControlRequest(message);
				return event ? [event] : this.ignore();
			}
			case 'result':
				return [parseResult(message)];
			default:
				// system and other message types carry no reply output
				return [];
		}
	}

	private parseStreamEvent(event: unknown): ClaudeStreamEvent[] {
		if (!isRecord(event)) {
			this.ignoredLines++;
			return [];
		}
		if (event.type === 'message_start') {
			this.sawDeltaInCurrentMessage = false;
			return [];
		}
		if (event.type === 'content_block_delta' && isRecord(event.delta) && event.delta.type === 'text_delta' && typeof event.delta.text === 'string') {
			this.sawDeltaInCurrentMessage = true;
			return event.delta.text.length > 0 ? [{ kind: 'text', text: event.delta.text }] : [];
		}
		return [];
	}

	private parseAssistantMessage(message: unknown): ClaudeStreamEvent[] {
		if (!isRecord(message) || !Array.isArray(message.content)) {
			this.ignoredLines++;
			return [];
		}
		const alreadyStreamed = this.sawDeltaInCurrentMessage;
		this.sawDeltaInCurrentMessage = false;

		const events: ClaudeStreamEvent[] = [];
		for (const block of message.content) {
			if (!isRecord(block)) {
				continue;
			}
			if (block.type === 'text' && !alreadyStreamed && typeof block.text === 'string' && block.text.length > 0) {
				events.push({ kind: 'text', text: block.text });
			} else if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
				this.openToolUses.set(block.id, { toolName: block.name, input: isRecord(block.input) ? block.input : {} });
			}
		}
		return events;
	}

	/** Turns `tool_result` blocks of a `user` message into events for their tool calls. */
	private parseToolResults(message: unknown): ClaudeStreamEvent[] {
		if (!isRecord(message) || !Array.isArray(message.content)) {
			return [];
		}
		const events: ClaudeStreamEvent[] = [];
		for (const block of message.content) {
			if (isRecord(block) && block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
				const toolUse = this.openToolUses.get(block.tool_use_id);
				if (toolUse) {
					this.openToolUses.delete(block.tool_use_id);
					events.push({ kind: 'toolResult', toolName: toolUse.toolName, input: toolUse.input, isError: block.is_error === true });
				}
			}
		}
		return events;
	}

	private ignore(): ClaudeStreamEvent[] {
		this.ignoredLines++;
		return [];
	}
}

/**
 * How a Claude Code tool call is shown to the user: a one-line `summary` for
 * activity lines and approval cards, and an optional longer `detail`.
 *
 * `workingDirectory` is the folder the CLI runs in, so paths inside it can be
 * shown relative to it.
 */
export function describeToolUse(toolName: string, input: ClaudeToolInput, workingDirectory: string | undefined): { readonly summary: string; readonly detail?: string } {
	const filePath = stringField(input, 'file_path');
	const pattern = stringField(input, 'pattern');
	switch (toolName) {
		case 'Edit':
		case 'Write':
		case 'Read':
			if (filePath !== undefined) {
				// The detail keeps the absolute path, so a shortened summary can be checked.
				return { summary: oneLine(`${toolName} ${displayPath(filePath, workingDirectory)}`), detail: filePath };
			}
			break;
		case 'Bash': {
			const command = stringField(input, 'command');
			if (command !== undefined) {
				// The full command is always in the detail: the summary may be cut short
				// and must never be the only thing the user sees before allowing it.
				return { summary: oneLine(`Run: ${command}`), detail: command };
			}
			break;
		}
		case 'Grep':
			if (pattern !== undefined) {
				const searchPath = stringField(input, 'path');
				const where = searchPath !== undefined ? ` in ${displayPath(searchPath, workingDirectory)}` : '';
				return { summary: oneLine(`Search for "${pattern}"${where}`) };
			}
			break;
		case 'Glob':
			if (pattern !== undefined) {
				return { summary: oneLine(`Find files matching ${pattern}`) };
			}
			break;
	}
	return { summary: oneLine(toolName) };
}

/** Longest summary shown before it is cut off with an ellipsis. */
const MAX_SUMMARY_LENGTH = 100;

function stringField(input: ClaudeToolInput, key: string): string | undefined {
	const value = input[key];
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Shows a path inside the working directory relative to it. Paths outside it
 * stay absolute, so they stand out.
 */
function displayPath(path: string, workingDirectory: string | undefined): string {
	if (workingDirectory === undefined || !isAbsolute(path)) {
		return path;
	}
	const relativePath = relative(workingDirectory, path);
	if (relativePath.length === 0) {
		return '.';
	}
	return relativePath.startsWith('..') || isAbsolute(relativePath) ? path : relativePath;
}

/**
 * Makes `text` a single short line: line breaks, tabs and control characters
 * become spaces, and a long text is cut off with an ellipsis. A multi-line
 * command therefore never looks like a harmless first line only.
 */
function oneLine(text: string): string {
	const flat = text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();
	return flat.length > MAX_SUMMARY_LENGTH ? `${flat.slice(0, MAX_SUMMARY_LENGTH - 1)}…` : flat;
}

function parseControlRequest(message: Record<string, unknown>): ClaudeStreamEvent | undefined {
	const request = message.request;
	if (typeof message.request_id !== 'string' || message.request_id.length === 0 || !isRecord(request) || typeof request.subtype !== 'string') {
		return undefined;
	}
	if (request.subtype === 'can_use_tool' && typeof request.tool_name === 'string') {
		return { kind: 'permission', requestId: message.request_id, toolName: request.tool_name, input: isRecord(request.input) ? request.input : {} };
	}
	return { kind: 'unsupportedControl', requestId: message.request_id, subtype: request.subtype };
}

function parseResult(message: Record<string, unknown>): ClaudeStreamEvent {
	const isError = message.is_error === true || (typeof message.subtype === 'string' && message.subtype !== 'success');
	if (!isError) {
		return { kind: 'result', isError: false };
	}
	return { kind: 'result', isError: true, errorMessage: describeResultError(message) };
}

function describeResultError(message: Record<string, unknown>): string {
	if (Array.isArray(message.errors)) {
		const errors = message.errors.filter((e): e is string => typeof e === 'string' && e.length > 0);
		if (errors.length > 0) {
			return errors.join('\n');
		}
	}
	if (typeof message.result === 'string' && message.result.length > 0) {
		return message.result;
	}
	if (typeof message.subtype === 'string') {
		return `Claude CLI reported ${message.subtype}.`;
	}
	return 'Claude CLI reported an error.';
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
