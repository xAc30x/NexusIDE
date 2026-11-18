/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NexusIDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { AIResult, IAIStreamDelta, IAIStreamReadResult } from '../../common/ai.js';
import { StreamHub } from '../../common/streamHub.js';

function unwrap<T>(result: AIResult<T>): T {
	if (!result.ok) {
		assert.fail(`Expected ok result, got error: ${result.error}`);
	}
	return result.value;
}

function readAll(hub: StreamHub, streamId: string, fromCursor = 0): IAIStreamReadResult {
	return unwrap(hub.read(streamId, fromCursor));
}

suite('StreamHub', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('numbers chunks from 0 in the order they are appended', () => {
		const hub = store.add(new StreamHub());
		const streamId = hub.createStream();

		assert.deepStrictEqual(hub.appendText(streamId, 'a'), { ok: true, value: 0 });
		assert.deepStrictEqual(hub.appendText(streamId, 'b'), { ok: true, value: 1 });
		assert.deepStrictEqual(hub.end(streamId, 'completed'), { ok: true, value: 2 });

		assert.deepStrictEqual(readAll(hub, streamId), {
			streamId,
			chunks: [
				{ kind: 'text', cursor: 0, text: 'a' },
				{ kind: 'text', cursor: 1, text: 'b' },
				{ kind: 'end', cursor: 2, reason: 'completed' },
			],
			nextCursor: 3,
			done: true,
			truncated: false,
		});
	});

	test('reads from the middle of a stream and resumes at nextCursor', () => {
		const hub = store.add(new StreamHub());
		const streamId = hub.createStream();
		for (const text of ['a', 'b', 'c']) {
			unwrap(hub.appendText(streamId, text));
		}

		const first = readAll(hub, streamId, 1);
		assert.deepStrictEqual(first.chunks.map(c => c.cursor), [1, 2]);
		assert.strictEqual(first.nextCursor, 3);
		assert.strictEqual(first.done, false);

		unwrap(hub.appendText(streamId, 'd'));
		const second = readAll(hub, streamId, first.nextCursor);
		assert.deepStrictEqual(second.chunks, [{ kind: 'text', cursor: 3, text: 'd' }]);
	});

	test('reading at nextCursor returns no chunks', () => {
		const hub = store.add(new StreamHub());
		const streamId = hub.createStream();
		unwrap(hub.appendText(streamId, 'a'));

		const result = readAll(hub, streamId, 1);
		assert.deepStrictEqual(result.chunks, []);
		assert.strictEqual(result.nextCursor, 1);
		assert.strictEqual(result.truncated, false);
	});

	test('replays an ended stream any number of times', () => {
		const hub = store.add(new StreamHub());
		const streamId = hub.createStream();
		unwrap(hub.appendText(streamId, 'hello'));
		unwrap(hub.end(streamId, 'completed'));

		assert.deepStrictEqual(readAll(hub, streamId), readAll(hub, streamId));
	});

	test('keeps only the most recent chunks and reports truncation', () => {
		const hub = store.add(new StreamHub({ maxChunksPerStream: 3 }));
		const streamId = hub.createStream();
		for (const text of ['a', 'b', 'c', 'd', 'e']) {
			unwrap(hub.appendText(streamId, text));
		}

		const fromStart = readAll(hub, streamId, 0);
		assert.deepStrictEqual(fromStart.chunks.map(c => c.cursor), [2, 3, 4]);
		assert.strictEqual(fromStart.truncated, true);

		const fromBuffered = readAll(hub, streamId, 2);
		assert.deepStrictEqual(fromBuffered.chunks.map(c => c.cursor), [2, 3, 4]);
		assert.strictEqual(fromBuffered.truncated, false);
	});

	test('records the reason and error of an ended stream', () => {
		const hub = store.add(new StreamHub());
		const failed = hub.createStream();
		const cancelled = hub.createStream();

		unwrap(hub.end(failed, 'failed', 'process exited with code 1'));
		unwrap(hub.end(cancelled, 'cancelled'));

		assert.deepStrictEqual(readAll(hub, failed).chunks, [{ kind: 'end', cursor: 0, reason: 'failed', error: 'process exited with code 1' }]);
		assert.deepStrictEqual(readAll(hub, cancelled).chunks, [{ kind: 'end', cursor: 0, reason: 'cancelled' }]);
	});

	test('refuses to append after a stream has ended', () => {
		const hub = store.add(new StreamHub());
		const streamId = hub.createStream();
		unwrap(hub.end(streamId, 'completed'));

		assert.strictEqual(hub.appendText(streamId, 'late').ok, false);
		assert.strictEqual(hub.end(streamId, 'completed').ok, false);
		assert.strictEqual(readAll(hub, streamId).nextCursor, 1);
	});

	test('refuses empty text', () => {
		const hub = store.add(new StreamHub());
		const streamId = hub.createStream();

		assert.strictEqual(hub.appendText(streamId, '').ok, false);
		assert.strictEqual(readAll(hub, streamId).nextCursor, 0);
	});

	test('returns an error for unknown streams', () => {
		const hub = store.add(new StreamHub());

		assert.strictEqual(hub.appendText('missing', 'a').ok, false);
		assert.strictEqual(hub.end('missing', 'completed').ok, false);
		assert.strictEqual(hub.read('missing', 0).ok, false);
	});

	test('returns an error for invalid or future cursors', () => {
		const hub = store.add(new StreamHub());
		const streamId = hub.createStream();
		unwrap(hub.appendText(streamId, 'a'));

		assert.strictEqual(hub.read(streamId, -1).ok, false);
		assert.strictEqual(hub.read(streamId, 0.5).ok, false);
		assert.strictEqual(hub.read(streamId, Number.NaN).ok, false);
		assert.strictEqual(hub.read(streamId, 2).ok, false);
	});

	test('fires an event for every appended chunk', () => {
		const hub = store.add(new StreamHub());
		const streamId = hub.createStream();
		const events: IAIStreamDelta[] = [];
		store.add(hub.onDidAppend(e => events.push(e)));

		unwrap(hub.appendText(streamId, 'a'));
		unwrap(hub.end(streamId, 'completed'));
		hub.appendText(streamId, 'ignored');

		assert.deepStrictEqual(events, [
			{ streamId, chunks: [{ kind: 'text', cursor: 0, text: 'a' }] },
			{ streamId, chunks: [{ kind: 'end', cursor: 1, reason: 'completed' }] },
		]);
	});

	test('removes the oldest ended streams beyond the limit and keeps active streams', () => {
		const hub = store.add(new StreamHub({ maxEndedStreams: 2 }));
		const active = hub.createStream();
		const ended = [hub.createStream(), hub.createStream(), hub.createStream()];
		for (const streamId of ended) {
			unwrap(hub.end(streamId, 'completed'));
		}

		assert.strictEqual(hub.read(ended[0], 0).ok, false);
		assert.strictEqual(hub.read(ended[1], 0).ok, true);
		assert.strictEqual(hub.read(ended[2], 0).ok, true);
		assert.strictEqual(hub.read(active, 0).ok, true);
	});

	test('creates distinct stream ids', () => {
		const hub = store.add(new StreamHub());
		assert.notStrictEqual(hub.createStream(), hub.createStream());
	});

	test('rejects invalid options', () => {
		assert.throws(() => new StreamHub({ maxChunksPerStream: 0 }));
		assert.throws(() => new StreamHub({ maxEndedStreams: 1.5 }));
	});
});
