/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NexusIDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { ViewAction } from '../../../browser/parts/views/viewPane.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { IsAuxiliaryWindowContext } from '../../../common/contextkeys.js';
import { EditorExtensions } from '../../../common/editor.js';
import { IViewContainersRegistry, IViewsRegistry, ViewContainer, ViewContainerLocation, Extensions as ViewExtensions } from '../../../common/views.js';
import { InNexusAgentsWindowContext, NEXUS_AGENTS_EDITOR_ID, NexusAgentsEditorInput, NexusAgentsEditorPane, OPEN_NEXUS_AGENTS_WINDOW_COMMAND_ID, openNexusAgentsWindow, SHOW_NEXUS_IDE_WINDOW_COMMAND_ID, showNexusIDEWindow } from './nexusAgentsEditor.js';
import { NEXUS_CHAT_VIEW_CONTAINER_ID, NEXUS_CHAT_VIEW_ID, NexusChatViewPane } from './nexusChatView.js';
import '../common/nexusChatConfiguration.js';

const nexusChatIcon = registerIcon('nexus-chat-view-icon', Codicon.commentDiscussion, localize('nexusChat.icon', "View icon of the NexusIDE chat view."));

const viewContainer: ViewContainer = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
	id: NEXUS_CHAT_VIEW_CONTAINER_ID,
	title: localize2('nexusChat.viewContainer', "NexusIDE Chat"),
	icon: nexusChatIcon,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [NEXUS_CHAT_VIEW_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: NEXUS_CHAT_VIEW_CONTAINER_ID,
	order: 6,
}, ViewContainerLocation.Sidebar, { doNotRegisterOpenCommand: true });

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([{
	id: NEXUS_CHAT_VIEW_ID,
	name: localize2('nexusChat.view', "NexusIDE Chat"),
	containerIcon: nexusChatIcon,
	containerTitle: viewContainer.title.value,
	singleViewPaneContainerTitle: viewContainer.title.value,
	ctorDescriptor: new SyncDescriptor(NexusChatViewPane),
	canToggleVisibility: false,
	canMoveView: true,
	openCommandActionDescriptor: {
		id: NEXUS_CHAT_VIEW_CONTAINER_ID,
		title: localize2('nexusChat.open', "Open NexusIDE Chat"),
		order: 1,
	},
}], viewContainer);

registerAction2(class NewNexusChatAction extends ViewAction<NexusChatViewPane> {
	constructor() {
		super({
			viewId: NEXUS_CHAT_VIEW_ID,
			id: 'nexusChat.newChat',
			title: localize2('nexusChat.newChat', "New Chat"),
			f1: true,
			icon: Codicon.add,
			menu: {
				id: MenuId.ViewTitle,
				group: 'navigation',
				when: ContextKeyExpr.equals('view', NEXUS_CHAT_VIEW_ID),
			},
		});
	}

	runInView(_accessor: ServicesAccessor, view: NexusChatViewPane): void {
		view.newChat();
	}
});

// The NexusIDE Agents window: a separate window with a chat that starts in Agent mode.

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(NexusAgentsEditorPane, NEXUS_AGENTS_EDITOR_ID, localize('nexusAgents.editor', "NexusIDE Agents")),
	[new SyncDescriptor(NexusAgentsEditorInput)]
);

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
		return openNexusAgentsWindow(accessor);
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
		return showNexusIDEWindow(accessor);
	}
});

// Top bar buttons. Each window evaluates them with its own context: the main
// window shows "Agent", the Agents window shows "IDE", and other windows that
// only show editors show neither.

MenuRegistry.appendMenuItem(MenuId.TitleBarAdjacentCenter, {
	command: {
		id: OPEN_NEXUS_AGENTS_WINDOW_COMMAND_ID,
		title: localize('nexusAgents.agentButton', "Agent"),
		tooltip: localize('nexusAgents.agentButtonTooltip', "Open the NexusIDE Agents window"),
	},
	when: IsAuxiliaryWindowContext.toNegated(),
	order: -1000,
});

MenuRegistry.appendMenuItem(MenuId.TitleBarAdjacentCenter, {
	command: {
		id: SHOW_NEXUS_IDE_WINDOW_COMMAND_ID,
		title: localize('nexusAgents.ideButton', "IDE"),
		tooltip: localize('nexusAgents.ideButtonTooltip', "Go back to the NexusIDE window with your code"),
	},
	when: ContextKeyExpr.and(IsAuxiliaryWindowContext, InNexusAgentsWindowContext),
	order: -1000,
});
