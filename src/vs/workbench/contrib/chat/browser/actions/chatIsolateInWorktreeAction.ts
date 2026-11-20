/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IAgentHostConnectionsService } from '../../../../../platform/agentHost/common/agentHostConnectionsService.js';
import { IAgentHostService } from '../../../../../platform/agentHost/common/agentService.js';
import { SessionConfigKey } from '../../../../../platform/agentHost/common/sessionConfigKeys.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IsSessionsWindowContext } from '../../../../common/contextkeys.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { CHAT_CATEGORY } from './chatActions.js';
import { isolateAgentHostChatInWorktree, type IIsolateChatWorktreeResult } from '../../common/isolateChatInWorktree.js';
import { isUntitledChatSession } from '../../common/model/chatUri.js';
import { IChatWidgetService } from '../chat.js';
import { applyAgentHostSessionConfigChange } from '../agentSessions/agentHost/applyAgentHostSessionConfig.js';
import { IAgentHostSessionWorkingDirectoryResolver } from '../agentSessions/agentHost/agentHostSessionWorkingDirectoryResolver.js';
import { getLocalAgentHostSessionProvider, toAgentHostBackendSessionUri } from '../agentSessions/agentHost/agentHostSessionUri.js';
import { IAgentHostUntitledProvisionalSessionService } from '../agentSessions/agentHost/agentHostUntitledProvisionalSessionService.js';

export const ISOLATE_CHAT_IN_WORKTREE_ACTION_ID = 'workbench.action.chat.isolateInWorktree';

/**
 * Explicit opt-in that moves the focused main-window chat onto an Agent Host
 * worktree. A normal send keeps editing the open folder. The Agents window is
 * where that worktree is reviewed.
 */
class IsolateChatInWorktreeAction extends Action2 {
	constructor() {
		super({
			id: ISOLATE_CHAT_IN_WORKTREE_ACTION_ID,
			title: localize2('chat.isolateInWorktree', "Isolate Chat in Worktree"),
			category: CHAT_CATEGORY,
			f1: true,
			precondition: ContextKeyExpr.and(ChatContextKeys.enabled, IsSessionsWindowContext.negate()),
			menu: [{
				id: MenuId.ChatInputSecondary,
				group: 'navigation',
				order: 5,
				when: ContextKeyExpr.and(ChatContextKeys.enabled, IsSessionsWindowContext.negate()),
			}],
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const widget = accessor.get(IChatWidgetService).lastFocusedWidget;
		const notificationService = accessor.get(INotificationService);
		const sessionResource = widget?.viewModel?.sessionResource;
		if (!widget || !sessionResource) {
			notificationService.info(localize('chat.isolateInWorktree.noChat', "Open a chat to isolate it in a worktree."));
			return;
		}

		const provider = getLocalAgentHostSessionProvider(sessionResource);
		const provisionalService = accessor.get(IAgentHostUntitledProvisionalSessionService);
		const connectionsService = accessor.get(IAgentHostConnectionsService);
		const workspaceContextService = accessor.get(IWorkspaceContextService);
		const workingDirectory = workspaceContextService.getWorkspace().folders[0]?.uri;
		const prompt = widget.getInput().trim() || localize('chat.isolateInWorktree.prompt', "Isolate this chat in a worktree");
		const isolationValue = provisionalService.getResolvedConfig(sessionResource)?.values[SessionConfigKey.Isolation];
		const resolution = connectionsService.resolveSessionResource(sessionResource);
		const untitled = isUntitledChatSession(sessionResource);

		const result = await isolateAgentHostChatInWorktree({
			provider,
			untitled,
			prompt,
			workingDirectory,
			isolation: typeof isolationValue === 'string' ? isolationValue : undefined,
			backendSession: provisionalService.get(sessionResource) ?? resolution?.backendSession ?? toAgentHostBackendSessionUri(sessionResource, connectionsService),
			connection: resolution?.connection,
		}, {
			ensureBackend: directory => provider ? provisionalService.getOrCreate(sessionResource, provider, directory) : Promise.resolve(undefined),
			setWorktreeIsolation: directory => setWorktreeIsolation(accessor, sessionResource, provider, untitled, directory),
		});
		notificationService.info(messageForResult(result));
	}
}

async function setWorktreeIsolation(accessor: ServicesAccessor, sessionResource: URI, provider: string | undefined, untitled: boolean, workingDirectory: URI | undefined): Promise<boolean> {
	if (!provider) {
		return false;
	}
	if (untitled) {
		const backend = await accessor.get(IAgentHostUntitledProvisionalSessionService).applyConfigChange(sessionResource, provider, workingDirectory, {
			[SessionConfigKey.Isolation]: 'worktree',
		});
		return !!backend;
	}
	return applyAgentHostSessionConfigChange(sessionResource, { [SessionConfigKey.Isolation]: 'worktree' }, {
		agentHostService: accessor.get(IAgentHostService),
		connectionsService: accessor.get(IAgentHostConnectionsService),
		provisionalService: accessor.get(IAgentHostUntitledProvisionalSessionService),
		workingDirectoryResolver: accessor.get(IAgentHostSessionWorkingDirectoryResolver),
		workspaceContextService: accessor.get(IWorkspaceContextService),
		configurationService: accessor.get(IConfigurationService),
	});
}

function messageForResult(result: IIsolateChatWorktreeResult): string {
	switch (result.outcome) {
		case 'already':
			return localize('chat.isolateInWorktree.already', "This chat is already set to run in a worktree. Review it in the Agents window.");
		case 'detached':
			return localize('chat.isolateInWorktree.detached', "Created a worktree at {0}. Review it in the Agents window.", result.worktree.scheme === 'file' ? result.worktree.fsPath : result.worktree.toString());
		case 'configured':
			return localize('chat.isolateInWorktree.configured', "This chat will run in a worktree. Review it in the Agents window.");
		case 'unsupported':
			return localize('chat.isolateInWorktree.unsupported', "Only an Agent Host chat in a folder can be isolated in a worktree.");
	}
}

registerAction2(IsolateChatInWorktreeAction);
