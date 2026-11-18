/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NexusIDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

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
	| { readonly kind: 'result'; readonly isError: boolean; readonly errorMessage?: string };

/**
 * Turns `stream-json` output lines of the Claude Code CLI into text and result
 * events.
 *
 * With `--include-partial-messages` the CLI sends text as `stream_event`
 * deltas and then repeats the whole message in an `assistant` line. Text from
 * an `assistant` line is therefore only used when no delta of that message was
 * seen, so text is never emitted twice. Lines that are not JSON or have an
 * unknown shape are ignored and counted in {@link ignoredLineCount}.
 */
export class ClaudeStreamParser {

	private sawDeltaInCurrentMessage = false;
	private ignoredLines = 0;

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
			case 'result':
				return [parseResult(message)];
			default:
				// system, user (tool results) and other message types carry no reply text
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
		if (alreadyStreamed) {
			return [];
		}

		const events: ClaudeStreamEvent[] = [];
		for (const block of message.content) {
			if (isRecord(block) && block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
				events.push({ kind: 'text', text: block.text });
			}
		}
		return events;
	}
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
