/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NexusIDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isIMenuItem, MenuId, MenuRegistry } from '../../../../../platform/actions/common/actions.js';
import { INativeHostService } from '../../../../../platform/native/common/native.js';
import { IWorkspace, IWorkspaceContextService, WorkbenchState } from '../../../../../platform/workspace/common/workspace.js';
import { isFolderToOpen, IWindowOpenable } from '../../../../../platform/window/common/window.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IHostService } from '../../../../services/host/browser/host.js';
import { IWorkbenchLayoutService, Parts } from '../../../../services/layout/browser/layoutService.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { InNexusAgentsWindowContext, NexusAgentsEditorInput } from '../../browser/nexusAgentsEditor.js';
import { NexusAgentsWindowService, OPEN_NEXUS_AGENTS_WINDOW_COMMAND_ID, SHOW_NEXUS_IDE_WINDOW_COMMAND_ID } from '../../electron-browser/nexusAgentsWindow.contribution.js';

suite('NexusAgentsWindowService', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const project = URI.file('/home/user/project');

	/**
	 * A NexusIDE window with the given folder, or an empty window. Windows
	 * created in one test talk to each other over the real broadcast channel.
	 */
	function createWindow(windowId: number, folder: URI | undefined) {
		const instantiationService = workbenchInstantiationService(undefined, store);
		const editors: EditorInput[] = [];
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
			override openEditor = (async (editor: EditorInput) => {
				editors.push(store.add(editor));
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
		const service = store.add(instantiationService.createInstance(NexusAgentsWindowService));
		const agentsFolders = () => editors.map(editor => editor instanceof NexusAgentsEditorInput ? editor.folder?.toString() : 'other');
		return { service, record, agentsFolders };
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

		await codeWindow.service.openAgentsWindow();
		assert.deepStrictEqual(codeWindow.record.focusedWindows, [2], 'the existing Agents window is brought to the front');
		assert.strictEqual(codeWindow.record.openedWindows.length, 1, 'no second Agents window');
	});

	test('IDE brings back the window with the folder, or opens a new one', async () => {
		const codeWindow = createWindow(1, project);
		await codeWindow.service.openAgentsWindow();
		const agentsWindow = createWindow(2, undefined);
		await agentsWindow.service.acceptHandoff();

		await agentsWindow.service.showIDEWindow();
		// With forceNewWindow, a window that has the folder open is focused instead of opening a second one.
		assert.deepStrictEqual(
			agentsWindow.record.openedWindows.map(({ toOpen, forceNewWindow }) => ({ folders: toOpen?.map(openable => isFolderToOpen(openable) ? openable.folderUri.toString() : 'other'), forceNewWindow })),
			[{ folders: [project.toString()], forceNewWindow: true }]);
	});

	test('a window with a folder, or one nobody opened for an Agents chat, stays as it is', async () => {
		const restoredEmptyWindow = createWindow(3, undefined);
		await restoredEmptyWindow.service.acceptHandoff();
		assert.deepStrictEqual(restoredEmptyWindow.agentsFolders(), []);
		assert.deepStrictEqual(restoredEmptyWindow.record.hiddenParts, []);

		const codeWindow = createWindow(1, project);
		await codeWindow.service.acceptHandoff();
		assert.deepStrictEqual(codeWindow.agentsFolders(), []);
	});

	test('the top bar shows Agent in code windows and IDE in Agents windows', () => {
		const buttons = MenuRegistry.getMenuItems(MenuId.TitleBarAdjacentCenter)
			.filter(isIMenuItem)
			.filter(item => item.command.id === OPEN_NEXUS_AGENTS_WINDOW_COMMAND_ID || item.command.id === SHOW_NEXUS_IDE_WINDOW_COMMAND_ID);
		const shownIn = (values: Record<string, unknown>) => buttons
			.filter(item => item.when?.evaluate({ getValue: <T>(key: string) => values[key] as T }) ?? true)
			.map(item => typeof item.command.title === 'string' ? item.command.title : item.command.title.value);

		assert.deepStrictEqual(shownIn({}), ['Agent'], 'code window');
		assert.deepStrictEqual(shownIn({ [InNexusAgentsWindowContext.key]: true }), ['IDE'], 'Agents window');
		assert.deepStrictEqual(shownIn({ isAuxiliaryWindow: true }), [], 'a window that only shows editors popped out of another');
	});
});
