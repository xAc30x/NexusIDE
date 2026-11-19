/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NexusIDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isIMenuItem, MenuId, MenuRegistry } from '../../../../../platform/actions/common/actions.js';
import { ContextKeyValue, IContextKey, IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { MockContextKeyService } from '../../../../../platform/keybinding/test/common/mockKeybindingService.js';
import { INativeHostService } from '../../../../../platform/native/common/native.js';
import { IWorkspace, IWorkspaceContextService, WorkbenchState } from '../../../../../platform/workspace/common/workspace.js';
import { isFolderToOpen, IWindowOpenable } from '../../../../../platform/window/common/window.js';
import { TitleBarLeadingActionsGroup } from '../../../../browser/parts/titlebar/titlebarActions.js';
import { GroupModelChangeKind } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IEditorService, IEditorsChangeEvent } from '../../../../services/editor/common/editorService.js';
import { IHostService } from '../../../../services/host/browser/host.js';
import { IWorkbenchLayoutService, Parts } from '../../../../services/layout/browser/layoutService.js';
import { ILifecycleService, LifecyclePhase } from '../../../../services/lifecycle/common/lifecycle.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { InNexusAgentsWindowContext, NexusAgentsEditorInput, nexusAgentsResource } from '../../browser/nexusAgentsEditor.js';
import { NexusAgentsWindowService, OPEN_NEXUS_AGENTS_WINDOW_COMMAND_ID, SHOW_NEXUS_IDE_WINDOW_COMMAND_ID } from '../../electron-browser/nexusAgentsWindow.contribution.js';

/** Reports each context key that is set, so a test can wait for the top bar button to change. */
class ObservableContextKeyService extends MockContextKeyService {
	readonly onDidSetKey = new Emitter<string>();

	override createKey<T extends ContextKeyValue = ContextKeyValue>(key: string, defaultValue: T | undefined): IContextKey<T> {
		const contextKey = super.createKey(key, defaultValue);
		const set = contextKey.set.bind(contextKey);
		contextKey.set = (value: T) => {
			set(value);
			this.onDidSetKey.fire(key);
		};
		return contextKey;
	}
}

suite('NexusAgentsWindowService', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const project = URI.file('/home/user/project');

	interface IWindowOptions {
		/** Editors the window has when it starts, as after a restart. */
		readonly restoredEditors?: EditorInput[];
		/** Resolves when the window has restored its editors. Restored right away when not given. */
		readonly restored?: Promise<void>;
	}

	/**
	 * A NexusIDE window with the given folder, or an empty window. Windows
	 * created in one test talk to each other over the real broadcast channel.
	 */
	function createWindow(windowId: number, folder: URI | undefined, options: IWindowOptions = {}) {
		const instantiationService = workbenchInstantiationService(undefined, store);
		const editors: EditorInput[] = (options.restoredEditors ?? []).map(editor => store.add(editor));
		const onDidEditorsChange = store.add(new Emitter<IEditorsChangeEvent>());
		const record = {
			openedWindows: [] as { readonly toOpen: IWindowOpenable[] | undefined; readonly forceNewWindow: boolean | undefined }[],
			focusedWindows: [] as (number | undefined)[],
			hiddenParts: [] as string[],
		};
		instantiationService.stub(INativeHostService, new class extends mock<INativeHostService>() {
			override readonly windowId = windowId;
			override async focusWindow(options?: { targetWindowId?: number }) {
				record.focusedWindows.push(options?.targetWindowId);
			}
		});
		instantiationService.stub(IHostService, 'openWindow', async (toOpen?: IWindowOpenable[] | object, options?: { forceNewWindow?: boolean }) => {
			record.openedWindows.push({ toOpen: Array.isArray(toOpen) ? toOpen : undefined, forceNewWindow: options?.forceNewWindow });
		});
		instantiationService.stub(IEditorService, new class extends mock<IEditorService>() {
			override get editors() { return editors; }
			override readonly onDidEditorsChange = onDidEditorsChange.event;
			override openEditor = (async (editor: EditorInput) => {
				editors.push(store.add(editor));
				onDidEditorsChange.fire({ groupId: 0, event: { kind: GroupModelChangeKind.EDITOR_OPEN } });
				return undefined;
			}) as IEditorService['openEditor'];
		});
		instantiationService.stub(IWorkspaceContextService, new class extends mock<IWorkspaceContextService>() {
			override getWorkbenchState() { return folder ? WorkbenchState.FOLDER : WorkbenchState.EMPTY; }
			override getWorkspace() { return { folders: folder ? [{ uri: folder }] : [] } as Partial<IWorkspace> as IWorkspace; }
		});
		instantiationService.stub(IWorkbenchLayoutService, 'setPartHidden', (hidden: boolean, part: Parts) => {
			if (hidden) {
				record.hiddenParts.push(part);
			}
		});
		instantiationService.stub(ILifecycleService, new class extends mock<ILifecycleService>() {
			override async when(phase: LifecyclePhase) {
				if (phase === LifecyclePhase.Restored && options.restored) {
					await options.restored;
				}
			}
		});
		const contextKeyService = new ObservableContextKeyService();
		const onDidSetContextKey = store.add(contextKeyService.onDidSetKey);
		instantiationService.stub(IContextKeyService, contextKeyService);
		const service = store.add(instantiationService.createInstance(NexusAgentsWindowService));
		const agentsFolders = () => editors.map(editor => editor instanceof NexusAgentsEditorInput ? editor.folder?.toString() : 'other');
		const closeAllEditors = () => {
			editors.length = 0;
			onDidEditorsChange.fire({ groupId: 0, event: { kind: GroupModelChangeKind.EDITOR_CLOSE } });
		};
		const button = () => contextKeyService.getContextKeyValue(InNexusAgentsWindowContext.key) === true ? 'IDE' : 'Agent';
		const whenButtonChanges = () => Event.toPromise(onDidSetContextKey.event);
		return { service, record, agentsFolders, closeAllEditors, button, whenButtonChanges };
	}

	function foldersOpened(window: ReturnType<typeof createWindow>) {
		return window.record.openedWindows.map(({ toOpen, forceNewWindow }) => ({ folders: toOpen?.map(openable => isFolderToOpen(openable) ? openable.folderUri.toString() : 'other'), forceNewWindow }));
	}

	test('Agent opens a new Agents window for the folder, then brings that window back', async () => {
		const codeWindow = createWindow(1, project);
		// Clicked twice, before the new window has started.
		await Promise.all([codeWindow.service.openAgentsWindow(), codeWindow.service.openAgentsWindow()]);
		assert.deepStrictEqual(codeWindow.record.openedWindows, [{ toOpen: undefined, forceNewWindow: undefined }], 'one new empty window');

		// The new window starts and asks what it was opened for.
		const agentsWindow = createWindow(2, undefined);
		await agentsWindow.service.acceptHandoff();
		assert.deepStrictEqual(agentsWindow.agentsFolders(), [project.toString()]);
		assert.deepStrictEqual(agentsWindow.record.hiddenParts, [Parts.SIDEBAR_PART, Parts.PANEL_PART, Parts.AUXILIARYBAR_PART]);
		assert.strictEqual(codeWindow.button(), 'Agent');
		assert.strictEqual(agentsWindow.button(), 'IDE');

		await codeWindow.service.openAgentsWindow();
		assert.deepStrictEqual(codeWindow.record.focusedWindows, [2], 'the existing Agents window is brought to the front');
		assert.strictEqual(codeWindow.record.openedWindows.length, 1, 'no second Agents window');
	});

	test('a new Agents window shows IDE as soon as it knows, before its chat has opened', async () => {
		const codeWindow = createWindow(1, project);
		await codeWindow.service.openAgentsWindow();

		const restored = new DeferredPromise<void>();
		const agentsWindow = createWindow(2, undefined, { restored: restored.p });
		assert.strictEqual(agentsWindow.button(), 'Agent', 'not known yet');
		const buttonChanged = agentsWindow.whenButtonChanges();
		const accepted = agentsWindow.service.acceptHandoff();
		await buttonChanged;
		assert.strictEqual(agentsWindow.button(), 'IDE');
		assert.deepStrictEqual(agentsWindow.agentsFolders(), [], 'the chat opens once the window has restored');

		await restored.complete();
		await accepted;
		assert.deepStrictEqual(agentsWindow.agentsFolders(), [project.toString()]);
	});

	test('an Agents window stays one when its chat tab is closed, and Agent opens the chat again', async () => {
		const codeWindow = createWindow(1, project);
		await codeWindow.service.openAgentsWindow();
		const agentsWindow = createWindow(2, undefined);
		await agentsWindow.service.acceptHandoff();

		agentsWindow.closeAllEditors();
		assert.strictEqual(agentsWindow.button(), 'IDE');

		await codeWindow.service.openAgentsWindow();
		assert.deepStrictEqual(codeWindow.record.focusedWindows, [2]);
		assert.strictEqual(codeWindow.record.openedWindows.length, 1, 'no second Agents window');
		assert.deepStrictEqual(agentsWindow.agentsFolders(), [project.toString()], 'the chat is back');

		agentsWindow.closeAllEditors();
		await agentsWindow.service.showIDEWindow();
		assert.deepStrictEqual(foldersOpened(agentsWindow), [{ folders: [project.toString()], forceNewWindow: true }], 'IDE still knows the folder');
	});

	test('IDE brings back the window with the folder, or opens a new one', async () => {
		const codeWindow = createWindow(1, project);
		await codeWindow.service.openAgentsWindow();
		const agentsWindow = createWindow(2, undefined);
		await agentsWindow.service.acceptHandoff();

		await agentsWindow.service.showIDEWindow();
		// With forceNewWindow, a window that has the folder open is focused instead of opening a second one.
		assert.deepStrictEqual(foldersOpened(agentsWindow), [{ folders: [project.toString()], forceNewWindow: true }]);
	});

	test('an Agents window restored after a restart is recognized by its chat', async () => {
		const restoredAgentsWindow = createWindow(2, undefined, { restoredEditors: [new NexusAgentsEditorInput(nexusAgentsResource(project))] });
		assert.strictEqual(restoredAgentsWindow.button(), 'IDE');
		await restoredAgentsWindow.service.showIDEWindow();
		assert.deepStrictEqual(foldersOpened(restoredAgentsWindow), [{ folders: [project.toString()], forceNewWindow: true }]);

		const codeWindowWithChat = createWindow(1, project, { restoredEditors: [new NexusAgentsEditorInput(nexusAgentsResource(project))] });
		assert.strictEqual(codeWindowWithChat.button(), 'Agent', 'a window with a folder is a code window');
	});

	test('a window with a folder, or one nobody opened for an Agents chat, stays as it is', async () => {
		const restoredEmptyWindow = createWindow(3, undefined);
		await restoredEmptyWindow.service.acceptHandoff();
		assert.deepStrictEqual(restoredEmptyWindow.agentsFolders(), []);
		assert.deepStrictEqual(restoredEmptyWindow.record.hiddenParts, []);
		assert.strictEqual(restoredEmptyWindow.button(), 'Agent');

		const codeWindow = createWindow(1, project);
		await codeWindow.service.acceptHandoff();
		assert.deepStrictEqual(codeWindow.agentsFolders(), []);
	});

	test('the top bar shows Agent in code windows and IDE in Agents windows, in the group that never hides', () => {
		const buttons = MenuRegistry.getMenuItems(MenuId.TitleBar)
			.filter(isIMenuItem)
			.filter(item => item.command.id === OPEN_NEXUS_AGENTS_WINDOW_COMMAND_ID || item.command.id === SHOW_NEXUS_IDE_WINDOW_COMMAND_ID);
		assert.deepStrictEqual(buttons.map(item => item.group), [TitleBarLeadingActionsGroup, TitleBarLeadingActionsGroup]);
		const shownIn = (values: Record<string, unknown>) => buttons
			.filter(item => item.when?.evaluate({ getValue: <T>(key: string) => values[key] as T }) ?? true)
			.map(item => typeof item.command.title === 'string' ? item.command.title : item.command.title.value);

		assert.deepStrictEqual(shownIn({}), ['Agent'], 'code window');
		assert.deepStrictEqual(shownIn({ [InNexusAgentsWindowContext.key]: true }), ['IDE'], 'Agents window');
		assert.deepStrictEqual(shownIn({ isAuxiliaryWindow: true }), [], 'a window that only shows editors popped out of another');
	});
});
