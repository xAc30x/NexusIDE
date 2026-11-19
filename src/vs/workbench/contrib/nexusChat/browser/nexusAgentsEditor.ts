/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NexusIDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Dimension } from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { MutableDisposable } from '../../../../base/common/lifecycle.js';
import { isEqual } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { EditorInputCapabilities, IEditorOpenContext, IEditorSerializer, IUntypedEditorInput } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { NexusAgentsShell } from './nexusAgentsShell.js';

export const NEXUS_AGENTS_EDITOR_ID = 'workbench.editor.nexusAgents';
export const NEXUS_AGENTS_SCHEME = 'nexus-agents';

/**
 * True in a window that was opened for the NexusIDE Agents chat, for as long
 * as it is open. The top bar shows the "IDE" button there, and the "Agent"
 * button in every other window.
 */
export const InNexusAgentsWindowContext = new RawContextKey<boolean>('nexusAgentsWindow', false, localize('nexusAgents.inWindow', "Whether the window was opened for the NexusIDE Agents chat."));

const nexusAgentsIcon = registerIcon('nexus-agents-editor-icon', Codicon.robot, localize('nexusAgents.icon', "Icon of the NexusIDE Agents window."));

/** The resource of the Agents chat that works in `folder`, or in no folder. */
export function nexusAgentsResource(folder: URI | undefined): URI {
	return URI.from({ scheme: NEXUS_AGENTS_SCHEME, path: '/agents', query: folder ? `folder=${encodeURIComponent(folder.toString())}` : '' });
}

/** The folder of an Agents chat resource, or `undefined` when it has none or the resource is not one. */
export function nexusAgentsFolder(resource: URI): URI | undefined {
	if (resource.scheme !== NEXUS_AGENTS_SCHEME) {
		return undefined;
	}
	const value = new URLSearchParams(resource.query).get('folder');
	if (!value) {
		return undefined;
	}
	try {
		return URI.parse(value, true);
	} catch {
		return undefined;
	}
}

/** The Agents chat for one folder. The folder is part of its resource, so it is restored after a restart. */
export class NexusAgentsEditorInput extends EditorInput {

	static readonly ID = 'workbench.input.nexusAgents';

	readonly folder: URI | undefined;

	constructor(readonly resource: URI) {
		super();
		this.folder = nexusAgentsFolder(resource);
	}

	override get typeId(): string {
		return NexusAgentsEditorInput.ID;
	}

	override get editorId(): string {
		return NEXUS_AGENTS_EDITOR_ID;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton;
	}

	override getName(): string {
		return localize('nexusAgents.name', "NexusIDE Agents");
	}

	override getDescription(): string | undefined {
		return this.folder?.fsPath;
	}

	override getIcon(): ThemeIcon {
		return nexusAgentsIcon;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(other) || (other instanceof NexusAgentsEditorInput && isEqual(other.resource, this.resource));
	}
}

export class NexusAgentsEditorSerializer implements IEditorSerializer {

	canSerialize(editor: EditorInput): boolean {
		return editor instanceof NexusAgentsEditorInput;
	}

	serialize(editor: EditorInput): string | undefined {
		return editor instanceof NexusAgentsEditorInput ? editor.resource.toString() : undefined;
	}

	deserialize(_instantiationService: IInstantiationService, serialized: string): EditorInput | undefined {
		try {
			const resource = URI.parse(serialized, true);
			return resource.scheme === NEXUS_AGENTS_SCHEME ? new NexusAgentsEditorInput(resource) : undefined;
		} catch {
			return undefined;
		}
	}
}

/** The Agents window: one list of conversations, Projects, and Automations. */
export class NexusAgentsEditorPane extends EditorPane {

	private readonly shell = this._register(new MutableDisposable<NexusAgentsShell>());
	private lastHeight: number | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super(NEXUS_AGENTS_EDITOR_ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this.shell.value = this.instantiationService.createInstance(NexusAgentsShell, parent);
		if (this.lastHeight !== undefined) {
			this.shell.value.layout(this.lastHeight);
		}
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (input instanceof NexusAgentsEditorInput) {
			this.shell.value?.show(input.folder);
			if (this.lastHeight !== undefined) {
				this.shell.value?.layout(this.lastHeight);
			}
		}
	}

	override layout(dimension: Dimension): void {
		this.lastHeight = dimension.height;
		this.shell.value?.layout(dimension.height);
	}

	override focus(): void {
		super.focus();
		this.shell.value?.focus();
	}

	protected override setEditorVisible(visible: boolean): void {
		super.setEditorVisible(visible);
		if (visible) {
			this.shell.value?.refresh();
		}
	}
}

/**
 * Shows the Agents chat for `folder` in this window, and hides the side bars
 * and the panel so the window looks like a chat window. They can be shown
 * again with the usual buttons.
 */
export async function showNexusAgentsChat(editorService: IEditorService, layoutService: IWorkbenchLayoutService, folder: URI | undefined): Promise<void> {
	await editorService.openEditor(new NexusAgentsEditorInput(nexusAgentsResource(folder)), { pinned: true });
	for (const part of [Parts.SIDEBAR_PART, Parts.PANEL_PART, Parts.AUXILIARYBAR_PART]) {
		layoutService.setPartHidden(true, part);
	}
}
