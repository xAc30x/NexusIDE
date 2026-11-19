/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NexusIDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isIMenuItem, MenuId, MenuRegistry } from '../../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ContextKeyValue, IContextKey, IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { MockContextKeyService } from '../../../../../platform/keybinding/test/common/mockKeybindingService.js';
import { INativeHostService } from '../../../../../platform/native/common/native.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IWorkspace, IWorkspaceContextService, WorkbenchState } from '../../../../../platform/workspace/common/workspace.js';
import { isFolderToOpen, IWindowOpenable } from '../../../../../platform/window/common/window.js';
import { TitleBarLeadingActionsGroup } from '../../../../browser/parts/titlebar/titlebarActions.js';
import { GroupModelChangeKind } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IEditorService, IEditorsChangeEvent } from '../../../../services/editor/common/editorService.js';
import { IHostService } from '../../../../services/host/browser/host.js';
import { IWorkbenchLayoutService, Parts } from '../../../../services/layout/browser/layoutService.js';
import { ILifecycleService, LifecyclePhase } from '../../../../services/lifecycle/common/lifecycle.js';
import { TestHostService, workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { INexusAgentsDocumentService, NexusAgentsDocumentService } from '../../browser/nexusAgentsDocumentService.js';
import { InNexusAgentsWindowContext, NexusAgentsEditorInput, nexusAgentsResource } from '../../browser/nexusAgentsEditor.js';
import { NexusAgentsWindowService, OPEN_NEXUS_AGENTS_WINDOW_COMMAND_ID, SHOW_NEXUS_IDE_WINDOW_COMMAND_ID } from '../../electron-browser/nexusAgentsWindow.contribution.js';
import { emptyNexusAgentsDocument, NEXUS_AGENTS_STORAGE_KEY, reviewDiffArguments, startLocalConversation } from '../../common/nexusAgentsDocument.js';

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

	function valueOf<T>(result: { ok: true; value: T } | { ok: false; error: string }): T {
		if (!result.ok) {
			throw new Error(result.error);
		}
		return result.value;
	}

	interface IWindowOptions {
		/** Editors the window has when it starts, as after a restart. */
		readonly restoredEditors?: EditorInput[];
		/** Resolves when the window has restored its editors. Restored right away when not given. */
		readonly restored?: Promise<void>;
		/** The saved Agents document. Windows in one test share it, as application storage does. */
		readonly documents?: NexusAgentsDocumentService;
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
		const documents = options.documents ?? store.add(instantiationService.createInstance(NexusAgentsDocumentService));
		instantiationService.stub(INexusAgentsDocumentService, documents);
		instantiationService.stub(ICommandService, new class extends mock<ICommandService>() {
			override executeCommand = async () => undefined;
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
		const host = instantiationService.get(IHostService) as TestHostService;
		const agentsFolders = () => editors.map(editor => editor instanceof NexusAgentsEditorInput ? editor.folder?.toString() : 'other');
		const closeAllEditors = () => {
			editors.length = 0;
			onDidEditorsChange.fire({ groupId: 0, event: { kind: GroupModelChangeKind.EDITOR_CLOSE } });
		};
		const button = () => contextKeyService.getContextKeyValue(InNexusAgentsWindowContext.key) === true ? 'IDE' : 'Agent';
		const whenButtonChanges = () => Event.toPromise(onDidSetContextKey.event);
		return { service, record, agentsFolders, closeAllEditors, button, whenButtonChanges, documents, host, instantiationService };
	}

	function foldersOpened(window: ReturnType<typeof createWindow>) {
		return window.record.openedWindows.map(({ toOpen, forceNewWindow }) => ({ folders: toOpen?.map(openable => isFolderToOpen(openable) ? openable.folderUri.toString() : 'other'), forceNewWindow }));
	}

	test('Agent opens one Agents window for the app, then brings that window back', async () => {
		const codeWindow = createWindow(1, project);
		const otherFolder = createWindow(4, URI.file('/home/user/other'));
		// Clicked twice, before the new window has started.
		await Promise.all([codeWindow.service.openAgentsWindow(), codeWindow.service.openAgentsWindow()]);
		assert.deepStrictEqual(codeWindow.record.openedWindows, [{ toOpen: undefined, forceNewWindow: undefined }], 'one new empty window');

		// The new window starts and asks what it was opened for. It is not bound to the folder.
		const agentsWindow = createWindow(2, undefined);
		await agentsWindow.service.acceptHandoff();
		assert.deepStrictEqual(agentsWindow.agentsFolders(), [undefined]);
		assert.deepStrictEqual(agentsWindow.record.hiddenParts, [Parts.SIDEBAR_PART, Parts.PANEL_PART, Parts.AUXILIARYBAR_PART]);
		assert.strictEqual(codeWindow.button(), 'Agent');
		assert.strictEqual(agentsWindow.button(), 'IDE');

		await otherFolder.service.openAgentsWindow();
		assert.deepStrictEqual(otherFolder.record.focusedWindows, [2], 'a second folder uses the same Agents window');
		assert.deepStrictEqual(otherFolder.record.openedWindows, []);
		assert.deepStrictEqual(codeWindow.documents.snapshot.selection, { kind: 'none' }, 'focusing the window does not change its selection');
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
		assert.deepStrictEqual(agentsWindow.agentsFolders(), [undefined]);
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
		assert.deepStrictEqual(agentsWindow.agentsFolders(), [undefined], 'the chat is back');

		agentsWindow.closeAllEditors();
		agentsWindow.documents.startLocalConversation(project);
		await agentsWindow.service.showIDEWindow();
		assert.deepStrictEqual(agentsWindow.record.focusedWindows, [1], 'IDE focuses the code window that already has the folder');
		assert.deepStrictEqual(foldersOpened(agentsWindow), []);
	});

	test('IDE focuses the code window that used the folder most recently', async () => {
		const older = createWindow(1, project);
		const newer = createWindow(2, project);
		await timeout(5);
		newer.host.setFocus(true);
		const agentsWindow = createWindow(3, undefined);
		agentsWindow.documents.startLocalConversation(project);

		await agentsWindow.service.showIDEWindow();
		assert.deepStrictEqual(agentsWindow.record.focusedWindows, [2]);
		assert.deepStrictEqual(foldersOpened(agentsWindow), []);
		assert.ok(older.service.lastReview === undefined);
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

	test('Agent brings the window forward and leaves the open Project selected', async () => {
		const codeWindow = createWindow(1, project);
		const agentsWindow = createWindow(2, undefined, { documents: codeWindow.documents });
		await codeWindow.service.openAgentsWindow();
		await agentsWindow.service.acceptHandoff();
		assert.ok(codeWindow.documents.signIn().ok);
		assert.ok(codeWindow.documents.connectGitHub().ok);
		const created = codeWindow.documents.createProject('Migration', 'acme/app', 'opus');
		assert.ok(created.ok);

		await codeWindow.service.openAgentsWindow();
		assert.deepStrictEqual(codeWindow.documents.snapshot.selection, { kind: 'project', id: valueOf(created) });
		assert.deepStrictEqual(codeWindow.record.focusedWindows, [2]);
	});

	test('the first clone of a repository asks for a parent directory and the next one reuses it', async () => {
		const agentsWindow = createWindow(2, undefined);
		assert.ok(agentsWindow.documents.signIn().ok);
		assert.ok(agentsWindow.documents.connectGitHub().ok);
		const created = agentsWindow.documents.createProject('Migration', 'acme/app', 'opus');
		assert.ok(created.ok);
		let asks = 0;
		const dialog = agentsWindow.instantiationService.get(IFileDialogService);
		dialog.showOpenDialog = (async () => {
			asks++;
			return [URI.file('/clones')];
		}) as IFileDialogService['showOpenDialog'];

		await agentsWindow.service.showIDEWindow();
		await agentsWindow.service.showIDEWindow();
		const folder = URI.file('/clones/app').toString();
		assert.strictEqual(asks, 1);
		assert.deepStrictEqual(foldersOpened(agentsWindow), [
			{ folders: [folder], forceNewWindow: true },
			{ folders: [folder], forceNewWindow: true },
		]);
	});

	test('IDE reviews an agent branch in the code window and does not check it out', async () => {
		const agentsWindow = createWindow(2, undefined);
		assert.ok(agentsWindow.documents.signIn().ok);
		assert.ok(agentsWindow.documents.connectGitHub().ok);
		const created = agentsWindow.documents.createProject('Migration', 'acme/app', 'opus');
		assert.ok(created.ok);
		agentsWindow.documents.rememberClone('acme/app', URI.file('/clones'));
		const folder = URI.parse(agentsWindow.documents.snapshot.clones['acme/app']);
		const codeWindow = createWindow(1, folder);
		const sent = agentsWindow.documents.messageProject(valueOf(created), 'Review the branch');
		const agentId = valueOf(sent);
		assert.ok(agentsWindow.documents.finishProjectAgent(valueOf(created), agentId).ok);

		await agentsWindow.service.showIDEWindow();
		assert.deepStrictEqual(agentsWindow.record.focusedWindows, [1]);
		assert.deepStrictEqual(foldersOpened(agentsWindow), []);
		// The review is sent to the other window, which hears it on the next turn.
		for (let attempt = 0; attempt < 20 && !codeWindow.service.lastReview; attempt++) {
			await timeout(0);
		}
		assert.deepStrictEqual(codeWindow.service.lastReview, {
			folder: folder.toString(),
			base: 'main',
			branch: `nexus/${agentId}`,
			checkout: false,
			args: reviewDiffArguments('main', `nexus/${agentId}`),
		});
	});

	test('a review waits until a code window exists, and is applied once without checking out', async () => {
		const agentsWindow = createWindow(2, undefined);
		assert.ok(agentsWindow.documents.signIn().ok);
		assert.ok(agentsWindow.documents.connectGitHub().ok);
		const created = agentsWindow.documents.createProject('Migration', 'acme/app', 'opus');
		assert.ok(created.ok);
		agentsWindow.documents.rememberClone('acme/app', URI.file('/clones'));
		const sent = agentsWindow.documents.messageProject(valueOf(created), 'Review the branch');
		const agentId = valueOf(sent);
		assert.ok(agentsWindow.documents.finishProjectAgent(valueOf(created), agentId).ok);

		await agentsWindow.service.showIDEWindow();
		const folder = agentsWindow.documents.snapshot.pendingReview?.folder;
		assert.ok(folder);
		const codeWindow = createWindow(1, URI.parse(folder), { documents: agentsWindow.documents });
		assert.strictEqual(codeWindow.service.lastReview?.checkout, false);
		assert.deepStrictEqual(codeWindow.service.lastReview?.args, reviewDiffArguments('main', `nexus/${agentId}`));
		assert.strictEqual(agentsWindow.documents.snapshot.pendingReview, undefined);
	});

	test('a conversation saved by another window shows up in this one', () => {
		const codeWindow = createWindow(1, project);
		const storage = codeWindow.instantiationService.get(IStorageService);
		const external = startLocalConversation(emptyNexusAgentsDocument(), project.toString(), 'from-other', 'thread');
		storage.store(NEXUS_AGENTS_STORAGE_KEY, JSON.stringify(external), StorageScope.APPLICATION, StorageTarget.MACHINE);
		assert.strictEqual(codeWindow.documents.snapshot.conversations[0]?.id, 'from-other');
	});

	test('an Automation with no repository does not open a code window', async () => {
		const agentsWindow = createWindow(2, undefined);
		assert.ok(agentsWindow.documents.signIn().ok);
		assert.ok(agentsWindow.documents.connectSlack().ok);
		const created = agentsWindow.documents.createAutomation({
			name: 'Ping',
			prompt: 'Say hello',
			model: 'opus',
			triggers: [{ kind: 'slack', event: 'message' }],
			repositories: [],
		});
		assert.ok(created.ok);

		await agentsWindow.service.showIDEWindow();
		assert.deepStrictEqual(foldersOpened(agentsWindow), []);
		assert.deepStrictEqual(agentsWindow.record.focusedWindows, []);
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
