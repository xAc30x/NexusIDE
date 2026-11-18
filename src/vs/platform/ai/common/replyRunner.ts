/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NexusIDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, CancellationTokenSource } from '../../../base/common/cancellation.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { AIResult } from './ai.js';

/**
 * An active run of one chat thread, returned by {@link ReplyRunner.tryStart}.
 */
export interface IReplyRun {
	readonly threadId: string;
	/** Raised when the run should stop, for example after {@link ReplyRunner.cancel}. */
	readonly token: CancellationToken;
	/**
	 * Releases the thread so a new run can start. Call it once the run's work
	 * has really stopped. Calling it again, or on a run that is no longer the
	 * thread's active run, does nothing.
	 */
	finish(): void;
}

class ReplyRun implements IReplyRun {

	private readonly source = new CancellationTokenSource();
	private finished = false;

	constructor(
		readonly threadId: string,
		private readonly onFinish: (run: ReplyRun) => void,
	) { }

	get token(): CancellationToken {
		return this.source.token;
	}

	cancel(): void {
		this.source.cancel();
	}

	finish(): void {
		if (this.finished) {
			return;
		}
		this.finished = true;
		this.onFinish(this);
		this.source.dispose();
	}
}

/**
 * Allows at most one active run per chat thread. Different threads can run at
 * the same time.
 *
 * Cancelling a run only raises its cancellation token. The thread stays locked
 * until the run calls {@link IReplyRun.finish}, so a new run cannot start while
 * the previous one is still producing output.
 */
export class ReplyRunner extends Disposable {

	private readonly runs = new Map<string, ReplyRun>();
	private disposed = false;

	/**
	 * Starts a run for `threadId`. Fails if the thread already has an active
	 * run or the runner has been disposed.
	 */
	tryStart(threadId: string): AIResult<IReplyRun> {
		if (this.disposed) {
			return { ok: false, error: 'The reply runner has been shut down.' };
		}
		if (threadId.length === 0) {
			return { ok: false, error: 'Thread id must not be empty.' };
		}
		if (this.runs.has(threadId)) {
			return { ok: false, error: `Thread ${threadId} already has an active run.` };
		}

		const run = new ReplyRun(threadId, finishedRun => {
			// Only the thread's current run may release the thread.
			if (this.runs.get(finishedRun.threadId) === finishedRun) {
				this.runs.delete(finishedRun.threadId);
			}
		});
		this.runs.set(threadId, run);
		return { ok: true, value: run };
	}

	/**
	 * Raises the cancellation token of the thread's active run. Returns `true`
	 * if the thread has an active run and `false` otherwise.
	 */
	cancel(threadId: string): boolean {
		const run = this.runs.get(threadId);
		if (!run) {
			return false;
		}
		run.cancel();
		return true;
	}

	isRunning(threadId: string): boolean {
		return this.runs.has(threadId);
	}

	/**
	 * Cancels and releases every active run. Later {@link tryStart} calls fail.
	 */
	override dispose(): void {
		this.disposed = true;
		for (const run of [...this.runs.values()]) {
			run.cancel();
			run.finish();
		}
		super.dispose();
	}
}
