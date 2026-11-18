/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NexusIDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { isWindows } from '../../../../base/common/platform.js';
import { ClaudeStreamEvent, ClaudeStreamParser, describeToolUse, LineBuffer } from '../../common/claudeStreamParser.js';

function line(value: object): string {
	return JSON.stringify(value);
}

function delta(text: string): string {
	return line({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
}

function assistant(...texts: string[]): string {
	return line({ type: 'assistant', message: { content: texts.map(text => ({ type: 'text', text })) } });
}

const messageStart = line({ type: 'stream_event', event: { type: 'message_start', message: {} } });

function parseAll(parser: ClaudeStreamParser, lines: string[]): ClaudeStreamEvent[] {
	return lines.flatMap(l => parser.parseLine(l));
}

suite('LineBuffer', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('joins a line that arrives in several chunks', () => {
		const buffer = new LineBuffer();
		assert.deepStrictEqual(buffer.push('{"a":'), []);
		assert.deepStrictEqual(buffer.push('1}\n{"b"'), ['{"a":1}']);
		assert.deepStrictEqual(buffer.push(':2}\n'), ['{"b":2}']);
		assert.deepStrictEqual(buffer.flush(), []);
	});

	test('accepts CRLF line endings and returns an unterminated last line on flush', () => {
		const buffer = new LineBuffer();
		assert.deepStrictEqual(buffer.push('one\r\ntwo\r'), ['one']);
		assert.deepStrictEqual(buffer.push('\nthree'), ['two']);
		assert.deepStrictEqual(buffer.flush(), ['three']);
		assert.deepStrictEqual(buffer.flush(), []);
	});
});

suite('ClaudeStreamParser', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('emits text deltas and skips the repeated assistant message', () => {
		const parser = new ClaudeStreamParser();
		assert.deepStrictEqual(parseAll(parser, [
			line({ type: 'system', subtype: 'init' }),
			messageStart,
			delta('Hel'),
			delta('lo'),
			assistant('Hello'),
			line({ type: 'result', subtype: 'success', is_error: false, result: 'Hello' }),
		]), [
			{ kind: 'text', text: 'Hel' },
			{ kind: 'text', text: 'lo' },
			{ kind: 'result', isError: false },
		]);
	});

	test('uses assistant messages when no deltas were sent', () => {
		const parser = new ClaudeStreamParser();
		assert.deepStrictEqual(parseAll(parser, [
			assistant('first ', 'part'),
			line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'file contents' }] } }),
			assistant('second'),
		]), [
			{ kind: 'text', text: 'first ' },
			{ kind: 'text', text: 'part' },
			{ kind: 'text', text: 'second' },
		]);
	});

	test('tracks deltas per message', () => {
		const parser = new ClaudeStreamParser();
		assert.deepStrictEqual(parseAll(parser, [
			messageStart,
			delta('streamed'),
			assistant('streamed'),
			messageStart,
			assistant('not streamed'),
		]), [
			{ kind: 'text', text: 'streamed' },
			{ kind: 'text', text: 'not streamed' },
		]);
	});

	test('ignores tool use blocks and non-text deltas', () => {
		const parser = new ClaudeStreamParser();
		assert.deepStrictEqual(parseAll(parser, [
			line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: {} }] } }),
			line({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{' } } }),
		]), []);
	});

	test('reports error results with their messages', () => {
		assert.deepStrictEqual(new ClaudeStreamParser().parseLine(line({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom', 'again'] })),
			[{ kind: 'result', isError: true, errorMessage: 'boom\nagain' }]);
		assert.deepStrictEqual(new ClaudeStreamParser().parseLine(line({ type: 'result', subtype: 'success', is_error: true, result: 'Credit balance is too low' })),
			[{ kind: 'result', isError: true, errorMessage: 'Credit balance is too low' }]);
		assert.deepStrictEqual(new ClaudeStreamParser().parseLine(line({ type: 'result', subtype: 'error_max_turns' })),
			[{ kind: 'result', isError: true, errorMessage: 'Claude CLI reported error_max_turns.' }]);
	});

	test('reports permission requests, unknown control requests and finished tool calls', () => {
		const parser = new ClaudeStreamParser();
		const input = { file_path: '/w/a.ts', content: 'x' };
		assert.deepStrictEqual(parseAll(parser, [
			line({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Write', input } }),
			line({ type: 'control_request', request_id: 'r2', request: { subtype: 'interrupt' } }),
			line({ type: 'control_request', request: { subtype: 'can_use_tool' } }),
			line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Write', input }, { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'ls' } }] } }),
			line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true }, { type: 'tool_result', tool_use_id: 'unknown' }] } }),
			line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1' }, { type: 'tool_result', tool_use_id: 't1' }] } }),
		]), [
			{ kind: 'permission', requestId: 'r1', toolName: 'Write', input },
			{ kind: 'unsupportedControl', requestId: 'r2', subtype: 'interrupt' },
			{ kind: 'toolResult', toolName: 'Bash', input: { command: 'ls' }, isError: true },
			{ kind: 'toolResult', toolName: 'Write', input, isError: false },
		]);
		assert.strictEqual(parser.ignoredLineCount, 1, 'the control request without an id is ignored');
	});

	test('ignores and counts lines that are not understood', () => {
		const parser = new ClaudeStreamParser();
		assert.deepStrictEqual(parseAll(parser, ['not json', '[1,2]', '"text"', line({ type: 'assistant', message: 'oops' }), '', '   ']), []);
		assert.strictEqual(parser.ignoredLineCount, 4);
	});
});

suite('describeToolUse', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const root = isWindows ? 'C:\\work' : '/work';
	const inRoot = (...parts: string[]) => [root, ...parts].join(isWindows ? '\\' : '/');
	const outside = isWindows ? 'C:\\other\\secret.txt' : '/other/secret.txt';

	test('describes the common tools', () => {
		const longCommand = 'npm test -- ' + 'x'.repeat(200);
		assert.deepStrictEqual([
			describeToolUse('Edit', { file_path: inRoot('src', 'app.ts'), old_string: 'a', new_string: 'b' }, root),
			describeToolUse('Write', { file_path: outside, content: 'hi' }, root),
			describeToolUse('Read', { file_path: 'relative.txt' }, root),
			describeToolUse('Bash', { command: 'npm test', description: 'Run tests' }, root),
			describeToolUse('Bash', { command: 'echo safe\nrm -rf ~' }, root),
			describeToolUse('Bash', { command: longCommand }, root).summary.length,
			describeToolUse('Grep', { pattern: 'TODO', path: inRoot('src') }, root),
			describeToolUse('Glob', { pattern: '**/*.ts' }, undefined),
		], [
			{ summary: `Edit ${['src', 'app.ts'].join(isWindows ? '\\' : '/')}`, detail: inRoot('src', 'app.ts') },
			{ summary: `Write ${outside}`, detail: outside },
			{ summary: 'Read relative.txt', detail: 'relative.txt' },
			{ summary: 'Run: npm test', detail: 'npm test' },
			{ summary: 'Run: echo safe rm -rf ~', detail: 'echo safe\nrm -rf ~' },
			100,
			{ summary: 'Search for "TODO" in src' },
			{ summary: 'Find files matching **/*.ts' },
		]);
	});

	test('falls back to the tool name for unknown tools and missing input', () => {
		assert.deepStrictEqual([
			describeToolUse('WebFetch', { url: 'https://example.com' }, root),
			describeToolUse('Edit', {}, root),
			describeToolUse('Bash', { command: 42 }, root),
		], [
			{ summary: 'WebFetch' },
			{ summary: 'Edit' },
			{ summary: 'Bash' },
		]);
	});
});
