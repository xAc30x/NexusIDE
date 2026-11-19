/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NexusIDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BroadcastDataChannel } from '../../../../base/browser/broadcast.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IsAuxiliaryWindowContext } from '../../../common/contextkeys.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';
import { InNexusAgentsWindowContext, NexusAgentsEditorInput, showNexusAgentsChat } from '../browser/nexusAgentsEditor.js';
import { NexusWindowCoordinator, NexusWindowMessage } from '../common/nexusWindowCoordinator.js';

export const OPEN_NEXUS_AGENTS_WINDOW_COMMAND_ID = 'nexusChat.openAgentsWindow';
export const SHOW_NEXUS_IDE_WINDOW_COMMAND_ID = 'nexusChat.showIDEWindow';
/** The channel all NexusIDE windows join to find each other. */
export const NEXUS_WINDOWS_CHANNEL = 'nexusIDE.windows';

export const INexusAgentsWindowService = createDecorator<INexusAgentsWindowService>('nexusAgentsWindowService');

/** Moves between the code window and the Agents window of a folder. Each is a separate window. */
export interface INexusAgentsWindowService {
	readonly _serviceBrand: undefined;
	/** Brings the Agents window of this window's folder to the front, or opens a new one. */
	openAgentsWindow(): Promise<void>;
	/** Brings the code window of this Agents window's folder to the front, or opens a new one. */
	showIDEWindow(): Promise<void>;
	/** Shows the Agents chat when another window opened this one for it. */
	acceptHandoff(): Promise<void>;
}

export class NexusAgentsWindowService extends Disposable implements INexusAgentsWindowService {

	declare readonly _serviceBrand: undefined;

	private readonly coordinator: NexusWindowCoordinator;

	constructor(
		@INativeHostService private readonly nativeHostService: INativeHostService,
		@IHostService private readonly hostService: IHostService,
		@IEditorService private readonly editorService: IEditorService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.coordinator = this._register(new NexusWindowCoordinator(
			this._register(new BroadcastDataChannel<NexusWindowMessage>(NEXUS_WINDOWS_CHANNEL)),
			{
				windowId: nativeHostService.windowId,
				agentsFolders: () => this.agentsChats().map(editor => folderKey(editor.folder)),
			},
		));
	}

	async openAgentsWindow(): Promise<void> {
		const key = folderKey(this.codeFolder());
		const windowId = await this.coordinator.findAgentsWindow(key);
		if (windowId !== undefined) {
			await this.nativeHostService.focusWindow({ targetWindowId: windowId });
			return;
		}
		if (this.coordinator.hasPendingHandoff(key)) {
			return; // the window is still starting
		}
		this.coordinator.offerHandoff(key);
		this.logService.trace('[NexusIDE] opening an Agents window', key);
		await this.hostService.openWindow();
	}

	async showIDEWindow(): Promise<void> {
		const folder = this.agentsChats()[0]?.folder;
		// With `forceNewWindow`, a window that already has the folder open is
		// brought to the front instead of opening a second one.
		if (folder) {
			await this.hostService.openWindow([{ folderUri: folder }], { forceNewWindow: true });
		} else {
			await this.hostService.openWindow();
		}
	}

	async acceptHandoff(): Promise<void> {
		// An Agents window starts as an empty window. Windows with a folder are code windows.
		if (this.workspaceContextService.getWorkbenchState() !== WorkbenchState.EMPTY) {
			return;
		}
		const key = await this.coordinator.claimHandoff();
		if (key === undefined) {
			return;
		}
		const folder = key ? URI.parse(key, true) : undefined;
		await showNexusAgentsChat(this.editorService, this.layoutService, folder);
	}

	/** The folder of this code window that an Agents chat works in: its first folder on disk. */
	private codeFolder(): URI | undefined {
		const folder = this.workspaceContextService.getWorkspace().folders[0]?.uri;
		return folder?.scheme === Schemas.file ? folder : undefined;
	}

	private agentsChats(): NexusAgentsEditorInput[] {
		return this.editorService.editors.filter((editor): editor is NexusAgentsEditorInput => editor instanceof NexusAgentsEditorInput);
	}
}

function folderKey(folder: URI | undefined): string {
	return folder?.toString() ?? '';
}

registerSingleton(INexusAgentsWindowService, NexusAgentsWindowService, InstantiationType.Eager);

/** Starts answering the other windows, and shows the Agents chat when this window was opened for it. */
class NexusAgentsWindowStartup implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.nexusAgentsWindowStartup';

	constructor(
		@INexusAgentsWindowService service: INexusAgentsWindowService,
		@ILogService logService: ILogService,
	) {
		service.acceptHandoff().catch(error => logService.error('[NexusIDE] could not show the Agents chat in this window', error));
	}
}

registerWorkbenchContribution2(NexusAgentsWindowStartup.ID, NexusAgentsWindowStartup, WorkbenchPhase.AfterRestored);

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

// Top bar buttons: "IDE" in an Agents window, "Agent" in every other window.
// Pop-out editor windows show neither.

MenuRegistry.appendMenuItem(MenuId.TitleBarAdjacentCenter, {
	command: {
		id: OPEN_NEXUS_AGENTS_WINDOW_COMMAND_ID,
		title: localize('nexusAgents.agentButton', "Agent"),
		tooltip: localize('nexusAgents.agentButtonTooltip', "Open the NexusIDE Agents window"),
	},
	when: ContextKeyExpr.and(IsAuxiliaryWindowContext.toNegated(), InNexusAgentsWindowContext.toNegated()),
	order: -1000,
});

MenuRegistry.appendMenuItem(MenuId.TitleBarAdjacentCenter, {
	command: {
		id: SHOW_NEXUS_IDE_WINDOW_COMMAND_ID,
		title: localize('nexusAgents.ideButton', "IDE"),
		tooltip: localize('nexusAgents.ideButtonTooltip', "Go to the NexusIDE window with your code"),
	},
	when: ContextKeyExpr.and(IsAuxiliaryWindowContext.toNegated(), InNexusAgentsWindowContext),
	order: -1000,
});
