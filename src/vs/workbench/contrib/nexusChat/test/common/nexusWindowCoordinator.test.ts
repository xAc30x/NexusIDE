/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NexusIDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { runWithFakedTimers } from '../../../../../base/test/common/timeTravelScheduler.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { INexusWindowChannel, NEXUS_HANDOFF_EXPIRY_MS, NexusWindowCoordinator, NexusWindowMessage } from '../../common/nexusWindowCoordinator.js';

/** Connects windows like a BroadcastChannel: a message reaches every other window, not the sender. */
class TestBus {
	private readonly windows: Emitter<NexusWindowMessage>[] = [];

	join(store: DisposableStore): INexusWindowChannel {
		const emitter = store.add(new Emitter<NexusWindowMessage>());
		this.windows.push(emitter);
		return {
			onDidReceiveData: emitter.event,
			postData: message => {
				for (const other of this.windows) {
					if (other !== emitter) {
						other.fire(message);
					}
				}
			},
		};
	}
}

suite('NexusWindowCoordinator', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createWindows(now: () => number = Date.now) {
		const disposables = store.add(new DisposableStore());
		const bus = new TestBus();
		const revealed: number[] = [];
		const reviews: { windowId: number; base: string; branch: string }[] = [];
		const window = (windowId: number, options: { agents?: boolean; folder?: string; focusedAt?: number } = {}) =>
			store.add(new NexusWindowCoordinator(bus.join(disposables), {
				windowId,
				isAgentsWindow: () => options.agents === true,
				codeFolder: () => options.folder,
				focusedAt: () => options.focusedAt ?? 0,
				revealAgents: () => revealed.push(windowId),
				showReview: (_folder, base, branch) => reviews.push({ windowId, base, branch }),
			}, now));
		return { window, revealed, reviews };
	}

	test('finds the one Agents window, whichever folder a code window has open', () => runWithFakedTimers({}, async () => {
		const { window, revealed } = createWindows();
		const codeWindow = window(1, { folder: 'file:///project' });
		window(2, { folder: 'file:///other' });
		window(3, { agents: true });

		assert.strictEqual(await codeWindow.findAgentsWindow(), 3);
		assert.deepStrictEqual(revealed, [3], 'the Agents window is told to show itself, without a new selection');
		const otherCodeWindow = window(4, { folder: 'file:///elsewhere' });
		assert.strictEqual(await otherCodeWindow.findAgentsWindow(), 3, 'a second folder uses the same Agents window');
	}));

	test('a new window becomes the Agents window once, with no folder attached', () => runWithFakedTimers({}, async () => {
		const { window } = createWindows();
		const codeWindow = window(1);
		const newWindow = window(2);
		const anotherNewWindow = window(3);

		assert.strictEqual(codeWindow.hasPendingHandoff(), false);
		codeWindow.offerHandoff();
		assert.strictEqual(codeWindow.hasPendingHandoff(), true, 'the window is still starting');

		assert.strictEqual(await newWindow.claimHandoff(), true);
		assert.strictEqual(codeWindow.hasPendingHandoff(), false);
		assert.strictEqual(await anotherNewWindow.claimHandoff(), false, 'a window opened for something else is not the Agents window');
	}));

	test('an offer that nobody claimed in time expires', () => runWithFakedTimers({}, async () => {
		let time = 1000;
		const { window } = createWindows(() => time);
		const codeWindow = window(1);
		const lateWindow = window(2);

		codeWindow.offerHandoff();
		time += NEXUS_HANDOFF_EXPIRY_MS + 1;
		assert.strictEqual(codeWindow.hasPendingHandoff(), false);
		assert.strictEqual(await lateWindow.claimHandoff(), false);
	}));

	test('the most recently used code window for a folder is the one IDE focuses', () => runWithFakedTimers({}, async () => {
		const { window } = createWindows();
		const agents = window(1, { agents: true });
		window(2, { folder: 'file:///project', focusedAt: 10 });
		window(3, { folder: 'file:///project', focusedAt: 50 });
		window(4, { folder: 'file:///other', focusedAt: 90 });

		assert.strictEqual(await agents.findCodeWindow('file:///project'), 3);
		assert.strictEqual(await agents.findCodeWindow('file:///missing'), undefined);
	}));

	test('a review is delivered to the chosen code window and does not check out a branch', () => runWithFakedTimers({}, async () => {
		const { window, reviews } = createWindows();
		const agents = window(1, { agents: true });
		window(2, { folder: 'file:///project' });
		agents.requestReview(2, 'file:///project', 'main', 'nexus/a1');
		assert.deepStrictEqual(reviews, [{ windowId: 2, base: 'main', branch: 'nexus/a1' }]);
	}));
});
