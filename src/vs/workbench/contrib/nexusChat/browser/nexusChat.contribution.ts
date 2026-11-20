/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NexusIDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { EditorExtensions, IEditorFactoryRegistry } from '../../../common/editor.js';
import { NEXUS_AGENTS_EDITOR_ID, NexusAgentsEditorInput, NexusAgentsEditorPane, NexusAgentsEditorSerializer } from './nexusAgentsEditor.js';
import './nexusAgentsDocumentService.js';
import '../common/nexusChatConfiguration.js';

// The main-window chat is the Agent Host chat panel. This contribution only
// registers the NexusIDE Agents editor. The commands and top bar buttons that
// move between windows are desktop-only, in
// ../electron-browser/nexusAgentsWindow.contribution.ts.

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(NexusAgentsEditorPane, NEXUS_AGENTS_EDITOR_ID, localize('nexusAgents.editor', "NexusIDE Agents")),
	[new SyncDescriptor(NexusAgentsEditorInput)]
);

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(NexusAgentsEditorInput.ID, NexusAgentsEditorSerializer);
