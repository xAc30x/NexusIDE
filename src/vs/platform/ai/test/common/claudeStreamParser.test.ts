/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NexusIDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ClaudeStreamEvent, ClaudeStreamParser, LineBuffer } from '../../common/claudeStreamParser.js';

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

	test('ignores and counts lines that are not understood', () => {
		const parser = new ClaudeStreamParser();
		assert.deepStrictEqual(parseAll(parser, ['not json', '[1,2]', '"text"', line({ type: 'assistant', message: 'oops' }), '', '   ']), []);
		assert.strictEqual(parser.ignoredLineCount, 4);
	});
});
