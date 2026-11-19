/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NexusIDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { timeout } from '../../../../../base/common/async.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { isIMenuItem, MenuId, MenuRegistry } from '../../../../../platform/actions/common/actions.js';
import { IAIService } from '../../../../../platform/ai/common/ai.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { MockContextKeyService } from '../../../../../platform/keybinding/test/common/mockKeybindingService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { IEditorPane, IEditorIdentifier } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { AUX_WINDOW_GROUP, IEditorService, PreferredGroup } from '../../../../services/editor/common/editorService.js';
import { IHostService } from '../../../../services/host/browser/host.js';
import { TestEditorGroupView, workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import '../../browser/nexusChat.contribution.js';
import { InNexusAgentsWindowContext, NexusAgentsEditorInput, NexusAgentsEditorPane, OPEN_NEXUS_AGENTS_WINDOW_COMMAND_ID, openNexusAgentsWindow, SHOW_NEXUS_IDE_WINDOW_COMMAND_ID, showNexusIDEWindow } from '../../browser/nexusAgentsEditor.js';
import { TestAIService } from '../common/testAIService.js';

suite('NexusAgentsEditor', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	// The input is shared by the whole app. Each test disposes it at its end, so the next test starts fresh.
	setup(() => {
		store.add(NexusAgentsEditorInput.instance);
	});

	test('there is one Agents window input, named NexusIDE Agents', () => {
		const input = NexusAgentsEditorInput.instance;
		assert.strictEqual(NexusAgentsEditorInput.instance, input, 'the same input is returned while it is alive');
		assert.strictEqual(input.getName(), 'NexusIDE Agents');
		assert.ok(input.matches(input));
		assert.ok(!input.matches(store.add(new class extends EditorInput {
			override get typeId() { return 'other'; }
			override get resource() { return URI.file('/other.ts'); }
		})), 'a different editor is not the Agents window');

		input.dispose();
		const next = store.add(NexusAgentsEditorInput.instance);
		assert.notStrictEqual(next, input, 'a new input is created after the old one is closed');
	});

	test('the Agents window shows a chat that starts in Agent mode', async () => {
		const instantiationService = workbenchInstantiationService(undefined, store);
		const aiService = store.add(new TestAIService());
		aiService.providers = [{ id: 'claude-cli', displayName: 'Claude Code CLI', kind: 'cli', available: true }];
		instantiationService.stub(IAIService, aiService);

		const pane = store.add(instantiationService.createInstance(NexusAgentsEditorPane, new TestEditorGroupView(0)));
		const parent = document.createElement('div');
		document.body.appendChild(parent);
		store.add({ dispose: () => parent.remove() });
		pane.create(parent);
		await timeout(0);

		const modeSelect = parent.querySelector<HTMLSelectElement>('.nexus-chat-select');
		assert.strictEqual(modeSelect?.value, 'agent');
		const input = parent.querySelector<HTMLTextAreaElement>('.nexus-chat-prompt');
		assert.ok(input, 'the chat has a message box');
		input.value = 'clean up';
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
		await timeout(0);
		assert.deepStrictEqual(aiService.requests.map(request => request.mode), ['agent']);
	});

	suite('openNexusAgentsWindow', () => {

		function setup(openIn: readonly IEditorIdentifier[]) {
			const instantiationService = workbenchInstantiationService(undefined, store);
			const opened: { readonly editor: unknown; readonly group: PreferredGroup | undefined }[] = [];
			const focusedWindows: Window[] = [];
			instantiationService.stub(IEditorService, 'findEditors', () => openIn);
			instantiationService.stub(IEditorService, 'openEditor', async (editor: unknown, _options: unknown, group: PreferredGroup | undefined) => {
				opened.push({ editor, group });
				return { group: { windowId: mainWindow.vscodeWindowId } } as Partial<IEditorPane> as IEditorPane;
			});
			instantiationService.stub(IHostService, 'focus', async (targetWindow: Window) => {
				focusedWindows.push(targetWindow);
			});
			return { run: () => instantiationService.invokeFunction(openNexusAgentsWindow), opened, focusedWindows };
		}

		test('opens the Agents window in a new window and brings it to the front', async () => {
			const { run, opened, focusedWindows } = setup([]);
			await run();
			assert.deepStrictEqual(opened, [{ editor: NexusAgentsEditorInput.instance, group: AUX_WINDOW_GROUP }]);
			assert.deepStrictEqual(focusedWindows, [mainWindow], 'the window that shows it is focused');
		});

		test('shows the open Agents window again instead of opening a second one', async () => {
			const { run, opened } = setup([{ groupId: 7, editor: NexusAgentsEditorInput.instance }]);
			await run();
			assert.deepStrictEqual(opened, [{ editor: NexusAgentsEditorInput.instance, group: 7 }]);
		});
	});
	test('the top bar shows Agent in the main window and IDE in the Agents window', () => {
		const buttons = MenuRegistry.getMenuItems(MenuId.TitleBarAdjacentCenter)
			.filter(isIMenuItem)
			.filter(item => item.command.id === OPEN_NEXUS_AGENTS_WINDOW_COMMAND_ID || item.command.id === SHOW_NEXUS_IDE_WINDOW_COMMAND_ID);
		const shownIn = (values: Record<string, unknown>) => buttons
			.filter(item => item.when?.evaluate({ getValue: <T>(key: string) => values[key] as T }) ?? true)
			.map(item => typeof item.command.title === 'string' ? item.command.title : item.command.title.value);

		assert.deepStrictEqual(shownIn({}), ['Agent'], 'main window');
		assert.deepStrictEqual(shownIn({ isAuxiliaryWindow: true, [InNexusAgentsWindowContext.key]: true }), ['IDE'], 'Agents window');
		assert.deepStrictEqual(shownIn({ isAuxiliaryWindow: true }), [], 'another window that only shows editors');
	});

	test('the Agents window marks its own window while it shows the chat', async () => {
		const instantiationService = workbenchInstantiationService(undefined, store);
		instantiationService.stub(IAIService, store.add(new TestAIService()));
		// The window's own context: the Agents window sets its key here, not in the main window.
		const windowContextKeyService = new MockContextKeyService();
		const windowInstantiationService = instantiationService.createChild(new ServiceCollection([IContextKeyService, windowContextKeyService]));
		store.add(windowInstantiationService);
		instantiationService.stub(IEditorGroupsService, 'getPart', () => ({}));
		instantiationService.stub(IEditorGroupsService, 'getScopedInstantiationService', () => windowInstantiationService);

		const pane = store.add(instantiationService.createInstance(NexusAgentsEditorPane, new TestEditorGroupView(0)));
		const parent = document.createElement('div');
		pane.create(parent);
		const inAgentsWindow = () => windowContextKeyService.getContextKeyValue(InNexusAgentsWindowContext.key);

		await pane.setInput(NexusAgentsEditorInput.instance, undefined, {}, CancellationToken.None);
		assert.strictEqual(inAgentsWindow(), true);
		pane.clearInput();
		assert.strictEqual(inAgentsWindow(), false, 'the key goes back to false when the chat is closed');
	});

	test('the IDE button brings the main window to the front', async () => {
		const instantiationService = workbenchInstantiationService(undefined, store);
		const focusedWindows: Window[] = [];
		instantiationService.stub(IHostService, 'focus', async (targetWindow: Window) => {
			focusedWindows.push(targetWindow);
		});
		await instantiationService.invokeFunction(showNexusIDEWindow);
		assert.deepStrictEqual(focusedWindows, [mainWindow]);
	});
});
