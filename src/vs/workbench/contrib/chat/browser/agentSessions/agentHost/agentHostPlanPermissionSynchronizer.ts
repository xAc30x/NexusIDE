/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { toErrorMessage } from '../../../../../../base/common/errorMessage.js';
import { Disposable, DisposableMap, DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { IAgentHostService } from '../../../../../../platform/agentHost/common/agentService.js';
import { IAgentHostConnectionsService } from '../../../../../../platform/agentHost/common/agentHostConnectionsService.js';
import { ClaudeSessionConfigKey } from '../../../../../../platform/agentHost/common/claudeSessionConfigKeys.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../../common/contributions.js';
import { IWorkbenchEnvironmentService } from '../../../../../services/environment/common/environmentService.js';
import { IChatWidget, IChatWidgetService } from '../../chat.js';
import { claudePermissionModeForChatModeChange } from '../../../common/claudePlanPermission.js';
import { SessionType } from '../../../common/chatSessionsService.js';
import { getChatSessionType } from '../../../common/model/chatUri.js';
import { applyAgentHostSessionConfigChange, type IApplyAgentHostSessionConfigServices } from './applyAgentHostSessionConfig.js';
import { IAgentHostSessionWorkingDirectoryResolver } from './agentHostSessionWorkingDirectoryResolver.js';
import { IAgentHostUntitledProvisionalSessionService } from './agentHostUntitledProvisionalSessionService.js';

/**
 * Writes Claude's permission mode when the main-window mode picker moves to or
 * from Plan. Accepting the existing plan card is what allows file edits.
 * The Agents window keeps its own approvals picker.
 */
export class AgentHostPlanPermissionSynchronizer extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.agentHostPlanPermissionSynchronizer';

	private readonly _widgetListeners = this._register(new DisposableMap<IChatWidget>());
	private readonly _previousModeIds = new WeakMap<IChatWidget, string | undefined>();
	private readonly _services: IApplyAgentHostSessionConfigServices;

	constructor(
		@IChatWidgetService private readonly _chatWidgetService: IChatWidgetService,
		@ILogService private readonly _logService: ILogService,
		@IWorkbenchEnvironmentService environmentService: IWorkbenchEnvironmentService,
		@IAgentHostService agentHostService: IAgentHostService,
		@IAgentHostConnectionsService connectionsService: IAgentHostConnectionsService,
		@IAgentHostUntitledProvisionalSessionService provisionalService: IAgentHostUntitledProvisionalSessionService,
		@IAgentHostSessionWorkingDirectoryResolver workingDirectoryResolver: IAgentHostSessionWorkingDirectoryResolver,
		@IWorkspaceContextService workspaceContextService: IWorkspaceContextService,
		@IConfigurationService configurationService: IConfigurationService,
	) {
		super();
		this._services = { agentHostService, connectionsService, provisionalService, workingDirectoryResolver, workspaceContextService, configurationService };
		if (environmentService.isSessionsWindow) {
			return;
		}

		for (const widget of this._chatWidgetService.getAllWidgets()) {
			this._attachWidget(widget);
		}
		this._register(this._chatWidgetService.onDidAddWidget(widget => this._attachWidget(widget)));
		this._register(this._chatWidgetService.onDidRemoveWidget(widget => {
			this._previousModeIds.delete(widget);
			this._widgetListeners.deleteAndDispose(widget);
		}));
	}

	private _attachWidget(widget: IChatWidget): void {
		if (this._widgetListeners.has(widget)) {
			return;
		}

		const store = new DisposableStore();
		store.add(widget.input.onDidChangeCurrentChatMode(() => this._sync(widget)));
		store.add(widget.onDidChangeViewModel(() => {
			// A restored Plan session should enter plan mode. A restored Agent session
			// must not reset a permission mode the user already chose.
			this._previousModeIds.delete(widget);
			this._sync(widget);
		}));
		this._widgetListeners.set(widget, store);
		this._sync(widget);
	}

	private _sync(widget: IChatWidget): void {
		const sessionResource = widget.viewModel?.sessionResource;
		const nextModeId = widget.input.currentModeObs.get().id;
		const previousModeId = this._previousModeIds.get(widget);
		this._previousModeIds.set(widget, nextModeId);
		if (!sessionResource || getChatSessionType(sessionResource) !== SessionType.AgentHostClaude) {
			return;
		}

		const permissionMode = claudePermissionModeForChatModeChange(previousModeId, nextModeId);
		if (!permissionMode) {
			return;
		}
		void this._apply(sessionResource, permissionMode);
	}

	private async _apply(sessionResource: URI, permissionMode: 'plan' | 'default'): Promise<void> {
		try {
			await applyAgentHostSessionConfigChange(sessionResource, { [ClaudeSessionConfigKey.PermissionMode]: permissionMode }, this._services);
		} catch (error) {
			this._logService.warn(`[AgentHostPlanPermission] Failed to set permission mode: ${toErrorMessage(error)}`);
		}
	}
}

registerWorkbenchContribution2(AgentHostPlanPermissionSynchronizer.ID, AgentHostPlanPermissionSynchronizer, WorkbenchPhase.Eventually);
