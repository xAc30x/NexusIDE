/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NexusIDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { AIResult } from '../../common/ai.js';
import { IReplyRun, ReplyRunner } from '../../common/replyRunner.js';

function unwrap<T>(result: AIResult<T>): T {
	if (!result.ok) {
		assert.fail(`Expected ok result, got error: ${result.error}`);
	}
	return result.value;
}

suite('ReplyRunner', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('allows only one active run per thread', () => {
		const runner = store.add(new ReplyRunner());
		const run = unwrap(runner.tryStart('thread-1'));

		const second = runner.tryStart('thread-1');
		assert.strictEqual(second.ok, false);
		assert.strictEqual(runner.isRunning('thread-1'), true);

		run.finish();
	});

	test('runs different threads at the same time', () => {
		const runner = store.add(new ReplyRunner());
		const a = unwrap(runner.tryStart('thread-a'));
		const b = unwrap(runner.tryStart('thread-b'));

		assert.strictEqual(runner.isRunning('thread-a'), true);
		assert.strictEqual(runner.isRunning('thread-b'), true);

		a.finish();
		b.finish();
	});

	test('finish releases the thread for a new run', () => {
		const runner = store.add(new ReplyRunner());
		unwrap(runner.tryStart('thread-1')).finish();

		assert.strictEqual(runner.isRunning('thread-1'), false);
		unwrap(runner.tryStart('thread-1')).finish();
	});

	test('cancel raises the token but keeps the thread locked until finish', () => {
		const runner = store.add(new ReplyRunner());
		const run = unwrap(runner.tryStart('thread-1'));
		let cancelEvents = 0;
		store.add(run.token.onCancellationRequested(() => cancelEvents++));

		assert.strictEqual(runner.cancel('thread-1'), true);

		assert.strictEqual(run.token.isCancellationRequested, true);
		assert.strictEqual(cancelEvents, 1);
		assert.strictEqual(runner.isRunning('thread-1'), true);
		assert.strictEqual(runner.tryStart('thread-1').ok, false);

		run.finish();
		assert.strictEqual(runner.isRunning('thread-1'), false);
	});

	test('cancel returns false for a thread without an active run', () => {
		const runner = store.add(new ReplyRunner());
		assert.strictEqual(runner.cancel('thread-1'), false);

		unwrap(runner.tryStart('thread-1')).finish();
		assert.strictEqual(runner.cancel('thread-1'), false);
	});

	test('cancel only affects the given thread', () => {
		const runner = store.add(new ReplyRunner());
		const a = unwrap(runner.tryStart('thread-a'));
		const b = unwrap(runner.tryStart('thread-b'));

		runner.cancel('thread-a');

		assert.strictEqual(a.token.isCancellationRequested, true);
		assert.strictEqual(b.token.isCancellationRequested, false);

		a.finish();
		b.finish();
	});

	test('a finished run cannot release a newer run of the same thread', () => {
		const runner = store.add(new ReplyRunner());
		const first = unwrap(runner.tryStart('thread-1'));
		first.finish();
		const second = unwrap(runner.tryStart('thread-1'));

		first.finish();

		assert.strictEqual(runner.isRunning('thread-1'), true);
		assert.strictEqual(runner.tryStart('thread-1').ok, false);
		second.finish();
	});

	test('refuses an empty thread id', () => {
		const runner = store.add(new ReplyRunner());
		assert.strictEqual(runner.tryStart('').ok, false);
	});

	test('dispose cancels and releases every run and refuses new runs', () => {
		const runner = new ReplyRunner();
		const runs: IReplyRun[] = [unwrap(runner.tryStart('thread-a')), unwrap(runner.tryStart('thread-b'))];

		runner.dispose();

		for (const run of runs) {
			assert.strictEqual(run.token.isCancellationRequested, true);
			run.finish();
		}
		assert.strictEqual(runner.isRunning('thread-a'), false);
		assert.strictEqual(runner.tryStart('thread-c').ok, false);
	});
});
