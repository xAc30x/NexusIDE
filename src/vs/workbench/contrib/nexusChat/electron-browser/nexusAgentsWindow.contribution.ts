/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NexusIDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BroadcastDataChannel } from '../../../../base/browser/broadcast.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr, IContextKey, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { TitleBarLeadingActionsGroup } from '../../../browser/parts/titlebar/titlebarActions.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IsAuxiliaryWindowContext } from '../../../common/contextkeys.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';
import { ILifecycleService, LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { INexusAgentsDocumentService } from '../browser/nexusAgentsDocumentService.js';
import { reviewDiffArguments } from '../common/nexusAgentsDocument.js';
import { InNexusAgentsWindowContext, NexusAgentsEditorInput, showNexusAgentsChat } from '../browser/nexusAgentsEditor.js';
import { NexusWindowCoordinator, NexusWindowMessage } from '../common/nexusWindowCoordinator.js';

export const OPEN_NEXUS_AGENTS_WINDOW_COMMAND_ID = 'nexusChat.openAgentsWindow';
export const SHOW_NEXUS_IDE_WINDOW_COMMAND_ID = 'nexusChat.showIDEWindow';
/** Opens a terminal in a local folder from the Agents window. */
export const OPEN_NEXUS_AGENTS_TERMINAL_COMMAND_ID = 'workbench.action.terminal.newWithCwd';
/** The channel all NexusIDE windows join to find each other. */
export const NEXUS_WINDOWS_CHANNEL = 'nexusIDE.windows';

export const INexusAgentsWindowService = createDecorator<INexusAgentsWindowService>('nexusAgentsWindowService');

/** Moves between code windows and the one Agents window. */
export interface INexusAgentsWindowService {
	readonly _serviceBrand: undefined;
	/** Brings the Agents window to the front, or opens it. The selection stays as it is. */
	openAgentsWindow(): Promise<void>;
	/** Brings the code window for the current selection to the front, or opens one. */
	showIDEWindow(): Promise<void>;
	/** Becomes the Agents window when another window opened this one for that. */
	acceptHandoff(): Promise<void>;
	/** The last diff this code window was asked to show. The checkout was not changed. */
	readonly lastReview: { readonly folder: string; readonly base: string; readonly branch: string; readonly checkout: false; readonly args: readonly string[] } | undefined;
}

export class NexusAgentsWindowService extends Disposable implements INexusAgentsWindowService {

	declare readonly _serviceBrand: undefined;

	private readonly coordinator: NexusWindowCoordinator;
	private readonly inAgentsWindow: IContextKey<boolean>;
	/**
	 * This window is the Agents window until it closes, even when its editor
	 * tab is closed. There is one such window for the application.
	 */
	private agentsWindow = false;
	private focusedAt = Date.now();
	private _lastReview: INexusAgentsWindowService['lastReview'];

	constructor(
		@INativeHostService private readonly nativeHostService: INativeHostService,
		@IHostService private readonly hostService: IHostService,
		@IEditorService private readonly editorService: IEditorService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@ILifecycleService private readonly lifecycleService: ILifecycleService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@ILogService private readonly logService: ILogService,
		@INexusAgentsDocumentService private readonly documents: INexusAgentsDocumentService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();
		this.inAgentsWindow = InNexusAgentsWindowContext.bindTo(contextKeyService);
		this.coordinator = this._register(new NexusWindowCoordinator(
			this._register(new BroadcastDataChannel<NexusWindowMessage>(NEXUS_WINDOWS_CHANNEL)),
			{
				windowId: nativeHostService.windowId,
				isAgentsWindow: () => this.agentsWindow,
				codeFolder: () => this.codeFolderKey(),
				focusedAt: () => this.focusedAt,
				revealAgents: () => this.revealShell(),
				showReview: (folder, base, branch) => this.showReview(folder, base, branch),
			},
		));
		this._register(hostService.onDidChangeFocus(focused => {
			if (focused) {
				this.focusedAt = Date.now();
			}
		}));
		this.documents.setTerminalOpener(folder => this.commandService.executeCommand(OPEN_NEXUS_AGENTS_TERMINAL_COMMAND_ID, { cwd: folder.fsPath }).then(() => undefined));
		// An Agents window restored after a restart is recognized by its editor.
		this.recognizeRestoredWindow();
		this._register(editorService.onDidEditorsChange(() => this.recognizeRestoredWindow()));
		const folder = this.codeFolder();
		if (folder) {
			const review = this.documents.consumePendingReview(folder);
			if (review) {
				this.showReview(folder.toString(), review.base, review.branch);
			}
		}
	}

	get lastReview(): INexusAgentsWindowService['lastReview'] {
		return this._lastReview;
	}

	async openAgentsWindow(): Promise<void> {
		const windowId = await this.coordinator.findAgentsWindow();
		if (windowId !== undefined) {
			await this.nativeHostService.focusWindow({ targetWindowId: windowId });
			return;
		}
		if (this.coordinator.hasPendingHandoff()) {
			return; // the window is still starting
		}
		this.coordinator.offerHandoff();
		this.logService.trace('[NexusIDE] opening the Agents window');
		await this.hostService.openWindow();
	}

	async showIDEWindow(): Promise<void> {
		const target = this.documents.resolveIdeTarget();
		if (target.kind === 'none') {
			return;
		}
		if (target.kind === 'clone') {
			await this.cloneRepository(target.repository);
			return;
		}
		const windowId = await this.coordinator.findCodeWindow(target.folder);
		if (target.review) {
			if (windowId !== undefined) {
				this.coordinator.requestReview(windowId, target.folder, target.review.base, target.review.branch);
			} else {
				this.documents.setPendingReview({ folder: target.folder, base: target.review.base, branch: target.review.branch });
			}
		}
		if (windowId !== undefined) {
			await this.nativeHostService.focusWindow({ targetWindowId: windowId });
			return;
		}
		await this.hostService.openWindow([{ folderUri: URI.parse(target.folder) }], { forceNewWindow: true });
	}

	async acceptHandoff(): Promise<void> {
		// An Agents window starts as an empty window. Windows with a folder are code windows.
		if (!this.canBeAgentsWindow() || this.agentsWindow) {
			return;
		}
		const claimed = await this.coordinator.claimHandoff();
		if (!claimed || this.agentsWindow) {
			return;
		}
		// The top bar shows "IDE" from here on, before a conversation is selected.
		this.becomeAgentsWindow();
		await this.lifecycleService.when(LifecyclePhase.Restored);
		await showNexusAgentsChat(this.editorService, this.layoutService, undefined);
	}

	private canBeAgentsWindow(): boolean {
		return this.workspaceContextService.getWorkbenchState() === WorkbenchState.EMPTY;
	}

	private becomeAgentsWindow(): void {
		this.agentsWindow = true;
		this.inAgentsWindow.set(true);
	}

	private recognizeRestoredWindow(): void {
		const chat = this.agentsChats()[0];
		if (chat && !this.agentsWindow && this.canBeAgentsWindow()) {
			this.becomeAgentsWindow();
			if (chat.folder) {
				this.documents.ensureLocalConversation(chat.folder);
			}
		}
	}

	/** Opens the shell again when its tab was closed. The selection is left as it is. */
	private revealShell(): void {
		if (this.agentsChats().length > 0) {
			return;
		}
		showNexusAgentsChat(this.editorService, this.layoutService, undefined)
			.catch(error => this.logService.error('[NexusIDE] could not show the Agents window again', error));
	}

	private showReview(folder: string, base: string, branch: string): void {
		// `git diff base...branch` reads the commits. It does not check out `branch`.
		const args = reviewDiffArguments(base, branch);
		this._lastReview = { folder, base, branch, checkout: false, args };
		const text = ['git', ...args].map(shellQuote).join(' ') + '\n';
		this.commandService.executeCommand(OPEN_NEXUS_AGENTS_TERMINAL_COMMAND_ID, { cwd: URI.parse(folder).fsPath })
			.then(() => this.commandService.executeCommand('workbench.action.terminal.sendSequence', { text }))
			.catch(error => this.logService.error('[NexusIDE] could not show the review diff', error));
	}

	private async cloneRepository(repository: string): Promise<void> {
		const remembered = this.documents.snapshot.cloneParents[repository];
		const parent = remembered
			? URI.parse(remembered)
			: (await this.fileDialogService.showOpenDialog({
				canSelectFolders: true,
				canSelectFiles: false,
				canSelectMany: false,
				title: localize('nexusAgents.cloneTitle', "Choose where to clone {0}", repository),
			}))?.[0];
		if (!parent) {
			return;
		}
		const folder = this.documents.rememberClone(repository, parent);
		await this.hostService.openWindow([{ folderUri: folder }], { forceNewWindow: true });
	}

	private codeFolder(): URI | undefined {
		const folder = this.workspaceContextService.getWorkspace().folders[0]?.uri;
		return folder?.scheme === Schemas.file ? folder : undefined;
	}

	private codeFolderKey(): string | undefined {
		return this.agentsWindow ? undefined : this.codeFolder()?.toString();
	}

	private agentsChats(): NexusAgentsEditorInput[] {
		return this.editorService.editors.filter((editor): editor is NexusAgentsEditorInput => editor instanceof NexusAgentsEditorInput);
	}
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

registerSingleton(INexusAgentsWindowService, NexusAgentsWindowService, InstantiationType.Eager);

/**
 * Starts answering the other windows, and shows the Agents window when this
 * window was opened for it. It starts with the window, so that a new Agents
 * window shows the "IDE" button from the start instead of "Agent".
 */
class NexusAgentsWindowStartup implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.nexusAgentsWindowStartup';

	constructor(
		@INexusAgentsWindowService service: INexusAgentsWindowService,
		@ILogService logService: ILogService,
	) {
		service.acceptHandoff().catch(error => logService.error('[NexusIDE] could not show the Agents window', error));
	}
}

registerWorkbenchContribution2(NexusAgentsWindowStartup.ID, NexusAgentsWindowStartup, WorkbenchPhase.BlockStartup);

registerAction2(class OpenNexusAgentsWindowAction extends Action2 {
	constructor() {
		super({
			id: OPEN_NEXUS_AGENTS_WINDOW_COMMAND_ID,
			title: localize2('nexusAgents.open', "Open Agents Window"),
			category: localize2('nexusChat.category', "NexusIDE"),
			f1: true,
		});
	}

	run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(INexusAgentsWindowService).openAgentsWindow();
	}
});

registerAction2(class ShowNexusIDEWindowAction extends Action2 {
	constructor() {
		super({
			id: SHOW_NEXUS_IDE_WINDOW_COMMAND_ID,
			title: localize2('nexusAgents.showIDE', "Go to IDE Window"),
			category: localize2('nexusChat.category', "NexusIDE"),
			f1: true,
			precondition: InNexusAgentsWindowContext,
		});
	}

	run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(INexusAgentsWindowService).showIDEWindow();
	}
});

// Top bar buttons: "IDE" in the Agents window, "Agent" in every other window.
// Pop-out editor windows show neither. They lead the buttons on the right of
// the top bar, which stay visible in a narrow window (the buttons next to the
// title are hidden when there is not enough room).

MenuRegistry.appendMenuItem(MenuId.TitleBar, {
	command: {
		id: OPEN_NEXUS_AGENTS_WINDOW_COMMAND_ID,
		title: localize('nexusAgents.agentButton', "Agent"),
		tooltip: localize('nexusAgents.agentButtonTooltip', "Open the NexusIDE Agents window"),
	},
	when: ContextKeyExpr.and(IsAuxiliaryWindowContext.toNegated(), InNexusAgentsWindowContext.toNegated()),
	group: TitleBarLeadingActionsGroup,
	order: -1000,
});

MenuRegistry.appendMenuItem(MenuId.TitleBar, {
	command: {
		id: SHOW_NEXUS_IDE_WINDOW_COMMAND_ID,
		title: localize('nexusAgents.ideButton', "IDE"),
		tooltip: localize('nexusAgents.ideButtonTooltip', "Go to the NexusIDE window with your code"),
	},
	when: ContextKeyExpr.and(IsAuxiliaryWindowContext.toNegated(), InNexusAgentsWindowContext),
	group: TitleBarLeadingActionsGroup,
	order: -1000,
});
