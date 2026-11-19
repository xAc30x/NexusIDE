/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NexusIDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { ViewAction } from '../../../browser/parts/views/viewPane.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { EditorExtensions, IEditorFactoryRegistry } from '../../../common/editor.js';
import { IViewContainersRegistry, IViewsRegistry, ViewContainer, ViewContainerLocation, Extensions as ViewExtensions } from '../../../common/views.js';
import { NEXUS_AGENTS_EDITOR_ID, NexusAgentsEditorInput, NexusAgentsEditorPane, NexusAgentsEditorSerializer } from './nexusAgentsEditor.js';
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

// The NexusIDE Agents chat, shown in its own window. The commands and top bar
// buttons that move between windows are desktop-only, in
// ../electron-browser/nexusAgentsWindow.contribution.ts.

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(NexusAgentsEditorPane, NEXUS_AGENTS_EDITOR_ID, localize('nexusAgents.editor', "NexusIDE Agents")),
	[new SyncDescriptor(NexusAgentsEditorInput)]
);

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(NexusAgentsEditorInput.ID, NexusAgentsEditorSerializer);
