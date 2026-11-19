/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NexusIDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
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
		const window = (windowId: number, agentsFolders: string[] = []) =>
			store.add(new NexusWindowCoordinator(bus.join(disposables), { windowId, agentsFolders: () => agentsFolders }, now));
		return { window };
	}

	test('finds the window that shows the Agents chat of the folder', () => runWithFakedTimers({}, async () => {
		const { window } = createWindows();
		const codeWindow = window(1);
		window(2, ['file:///other']);
		window(3, ['file:///project']);

		assert.strictEqual(await codeWindow.findAgentsWindow('file:///project'), 3);
		assert.strictEqual(await codeWindow.findAgentsWindow(''), undefined, 'no window has an Agents chat without a folder');
	}));

	test('a new window gets the folder it was opened for, only once', () => runWithFakedTimers({}, async () => {
		const { window } = createWindows();
		const codeWindow = window(1);
		const newWindow = window(2);
		const anotherNewWindow = window(3);

		assert.strictEqual(codeWindow.hasPendingHandoff('file:///project'), false);
		codeWindow.offerHandoff('file:///project');
		assert.strictEqual(codeWindow.hasPendingHandoff('file:///project'), true, 'the window is still starting');

		assert.strictEqual(await newWindow.claimHandoff(), 'file:///project');
		assert.strictEqual(codeWindow.hasPendingHandoff('file:///project'), false);
		assert.strictEqual(await anotherNewWindow.claimHandoff(), undefined, 'a window opened for something else gets nothing');
	}));

	test('an offer that nobody claimed in time expires', () => runWithFakedTimers({}, async () => {
		let time = 1000;
		const { window } = createWindows(() => time);
		const codeWindow = window(1);
		const lateWindow = window(2);

		codeWindow.offerHandoff('');
		time += NEXUS_HANDOFF_EXPIRY_MS + 1;
		assert.strictEqual(codeWindow.hasPendingHandoff(''), false);
		assert.strictEqual(await lateWindow.claimHandoff(), undefined);
	}));
});
