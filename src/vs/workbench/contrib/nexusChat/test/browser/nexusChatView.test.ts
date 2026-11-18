/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NexusIDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { Event } from '../../../../../base/common/event.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IAIProviderInfo, IAIService } from '../../../../../platform/ai/common/ai.js';
import { IViewContainerModel, IViewDescriptorService, ViewContainer, ViewContainerLocation } from '../../../../common/views.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { TestViewsService, workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { NexusChatViewPane } from '../../browser/nexusChatView.js';
import { TestAIService } from '../common/testAIService.js';

class TestViewDescriptorService extends mock<IViewDescriptorService>() {
	override readonly onDidChangeLocation = Event.None;

	override getViewLocationById(): ViewContainerLocation {
		return ViewContainerLocation.Sidebar;
	}

	override getViewDescriptorById(): null {
		return null;
	}

	override getViewContainerByViewId(): ViewContainer {
		return new class extends mock<ViewContainer>() {
			override readonly id = 'workbench.view.nexusChatTest';
		};
	}

	override getViewContainerModel(): IViewContainerModel {
		return new class extends mock<IViewContainerModel>() {
			override readonly title = 'NexusIDE Chat';
			override readonly onDidChangeContainerInfo = Event.None;
		};
	}

	override getDefaultContainerById(): null {
		return null;
	}
}

/** Lets pending promise callbacks settle. */
function settle(): Promise<void> {
	return timeout(0);
}

function provider(id: string, available: boolean): IAIProviderInfo {
	return { id, displayName: id === 'claude-cli' ? 'Claude Code CLI' : id, kind: 'cli', available };
}

suite('NexusChatViewPane', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	async function createPane(providers: readonly IAIProviderInfo[]) {
		const aiService = store.add(new TestAIService());
		aiService.providers = providers;
		const instantiationService = workbenchInstantiationService(undefined, store);
		instantiationService.stub(IViewDescriptorService, new TestViewDescriptorService());
		instantiationService.stub(IViewsService, new TestViewsService());
		instantiationService.stub(IAIService, aiService);

		const pane = store.add(instantiationService.createInstance(NexusChatViewPane, { id: 'nexusChatTest', title: 'NexusIDE Chat' }));
		const container = document.createElement('div');
		document.body.appendChild(container);
		store.add({ dispose: () => container.remove() });
		pane.render();
		container.appendChild(pane.element);
		pane.setExpanded(true);
		pane.layout(400);
		await settle();

		const query = <T extends Element>(selector: string): T => {
			const element = pane.element.querySelector<T>(selector);
			assert.ok(element, `missing element ${selector}`);
			return element;
		};
		const input = query<HTMLTextAreaElement>('.nexus-chat-prompt');
		const pressEnter = (shiftKey = false) => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey, bubbles: true, cancelable: true }));
		const messageTexts = () => [...pane.element.querySelectorAll('.nexus-chat-message')].map(message => ({
			role: message.querySelector('.nexus-chat-message-role')?.textContent,
			text: message.querySelector('.nexus-chat-message-text')?.textContent,
			status: message.querySelector<HTMLElement>('.nexus-chat-message-status')?.textContent,
		}));

		return { aiService, pane, query, input, pressEnter, messageTexts };
	}

	test('sends with Enter, streams the reply as plain text and switches Send to Stop', async () => {
		const { aiService, query, input, pressEnter, messageTexts } = await createPane([provider('claude-cli', true), provider('echo', true)]);

		assert.strictEqual(query<HTMLSelectElement>('.nexus-chat-provider').value, 'claude-cli');
		assert.strictEqual(query('.nexus-chat-send').textContent, 'Send');

		query<HTMLSelectElement>('.nexus-chat-select').value = 'plan';
		input.value = 'What does this repo do?';
		pressEnter(true);
		await settle();
		assert.strictEqual(aiService.requests.length, 0, 'Shift+Enter does not send');

		pressEnter();
		await settle();
		assert.strictEqual(aiService.requests.length, 1);
		assert.strictEqual(aiService.requests[0].prompt, 'What does this repo do?');
		assert.strictEqual(aiService.requests[0].mode, 'plan');
		assert.strictEqual(aiService.requests[0].providerId, 'claude-cli');
		assert.strictEqual(input.value, '', 'the prompt box is cleared after sending');
		assert.strictEqual(query('.nexus-chat-send').textContent, 'Stop');
		assert.deepStrictEqual(messageTexts(), [
			{ role: 'You', text: 'What does this repo do?', status: '' },
			{ role: 'AI', text: '', status: 'Thinking…' },
		]);

		const streamId = aiService.streamIds[0];
		aiService.hub.appendText(streamId, '<b>not bold</b> ');
		aiService.hub.appendText(streamId, 'done');
		aiService.hub.end(streamId, 'completed');

		assert.deepStrictEqual(messageTexts()[1], { role: 'AI', text: '<b>not bold</b> done', status: '' });
		assert.strictEqual(query('.nexus-chat-message.assistant .nexus-chat-message-text').querySelector('b'), null, 'reply text is never parsed as HTML');
		assert.strictEqual(query('.nexus-chat-send').textContent, 'Send');
	});

	test('Stop cancels the reply and the reply shows as stopped', async () => {
		const { aiService, query, input, pressEnter, messageTexts } = await createPane([provider('claude-cli', true)]);
		input.value = 'hi';
		pressEnter();
		await settle();

		query<HTMLElement>('.nexus-chat-send').click();
		await settle();
		assert.strictEqual(aiService.cancelledThreads.length, 1);

		aiService.hub.end(aiService.streamIds[0], 'cancelled');
		assert.strictEqual(messageTexts()[1].status, 'Stopped.');
		assert.strictEqual(query('.nexus-chat-send').textContent, 'Send');
	});

	test('shows the error of a failed reply', async () => {
		const { aiService, input, pressEnter, messageTexts } = await createPane([provider('claude-cli', true)]);
		aiService.sendResponse = async () => ({ ok: false, error: 'Provider Claude Code CLI is not available.' });
		input.value = 'hi';
		pressEnter();
		await settle();

		assert.deepStrictEqual(messageTexts()[1], { role: 'AI', text: '', status: 'Error: Provider Claude Code CLI is not available.' });
	});

	test('explains what to do when no provider is available and sends nothing', async () => {
		const { aiService, query, input, pressEnter, messageTexts } = await createPane([provider('claude-cli', false)]);

		const select = query<HTMLSelectElement>('.nexus-chat-provider');
		assert.deepStrictEqual([...select.options].map(option => [option.textContent, option.disabled]), [['Claude Code CLI (not available)', true]]);

		input.value = 'hi';
		pressEnter();
		await settle();

		assert.strictEqual(aiService.requests.length, 0);
		assert.deepStrictEqual(messageTexts(), []);
		const notice = query<HTMLElement>('.nexus-chat-notice');
		assert.strictEqual(notice.style.display, 'block');
		assert.ok(notice.textContent?.includes('Claude Code CLI'), notice.textContent ?? '');
		assert.strictEqual(input.value, 'hi', 'the prompt is kept');
	});

	test('New chat clears the messages', async () => {
		const { aiService, pane, input, pressEnter, messageTexts } = await createPane([provider('claude-cli', true)]);
		input.value = 'hi';
		pressEnter();
		await settle();
		aiService.hub.end(aiService.streamIds[0], 'completed');
		assert.strictEqual(messageTexts().length, 2);

		pane.newChat();
		assert.deepStrictEqual(messageTexts(), []);
	});
});
