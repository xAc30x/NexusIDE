/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NexusIDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Dimension, getWindowById } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { EditorInputCapabilities, IEditorOpenContext, IUntypedEditorInput } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorGroup, IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { AUX_WINDOW_GROUP, IEditorService } from '../../../services/editor/common/editorService.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { NexusChatWidget } from './nexusChatWidget.js';

export const NEXUS_AGENTS_EDITOR_ID = 'workbench.editor.nexusAgents';
export const OPEN_NEXUS_AGENTS_WINDOW_COMMAND_ID = 'nexusChat.openAgentsWindow';
export const SHOW_NEXUS_IDE_WINDOW_COMMAND_ID = 'nexusChat.showIDEWindow';

/**
 * True in a window that shows the NexusIDE Agents window. It is set on that
 * window's own context, so the top bar of each window can show its own button.
 */
export const InNexusAgentsWindowContext = new RawContextKey<boolean>('nexusAgentsWindow', false, localize('nexusAgents.inWindow', "Whether the window shows the NexusIDE Agents window."));

const nexusAgentsIcon = registerIcon('nexus-agents-editor-icon', Codicon.robot, localize('nexusAgents.icon', "Icon of the NexusIDE Agents window."));

/**
 * The content of the NexusIDE Agents window. There is only one: opening it
 * again shows the existing one.
 */
export class NexusAgentsEditorInput extends EditorInput {

	static readonly ID = 'workbench.input.nexusAgents';

	private static _instance: NexusAgentsEditorInput | undefined;

	static get instance(): NexusAgentsEditorInput {
		if (!NexusAgentsEditorInput._instance || NexusAgentsEditorInput._instance.isDisposed()) {
			NexusAgentsEditorInput._instance = new NexusAgentsEditorInput();
		}
		return NexusAgentsEditorInput._instance;
	}

	readonly resource = URI.from({ scheme: 'nexus-agents', path: 'default' });

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

	override getIcon(): ThemeIcon {
		return nexusAgentsIcon;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(other) || other instanceof NexusAgentsEditorInput;
	}
}

/** Shows a NexusIDE chat that starts in Agent mode. */
export class NexusAgentsEditorPane extends EditorPane {

	private widget: NexusChatWidget | undefined;
	private inAgentsWindow: IContextKey<boolean> | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
	) {
		super(NEXUS_AGENTS_EDITOR_ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this.widget = this._register(this.instantiationService.createInstance(NexusChatWidget, parent, { initialMode: 'agent' }));
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this.windowContextKey().set(true);
	}

	override clearInput(): void {
		this.windowContextKey().reset();
		super.clearInput();
	}

	/** The context key of the window that shows this editor, which the window's top bar reads. */
	private windowContextKey(): IContextKey<boolean> {
		if (!this.inAgentsWindow) {
			const part = this.editorGroupsService.getPart(this.group);
			const windowContextKeyService = this.editorGroupsService.getScopedInstantiationService(part).invokeFunction(accessor => accessor.get(IContextKeyService));
			this.inAgentsWindow = InNexusAgentsWindowContext.bindTo(windowContextKeyService);
		}
		return this.inAgentsWindow;
	}

	override layout(dimension: Dimension): void {
		this.widget?.layout(dimension.height);
	}

	override focus(): void {
		super.focus();
		this.widget?.focus();
	}

	protected override setEditorVisible(visible: boolean): void {
		super.setEditorVisible(visible);
		if (visible) {
			void this.widget?.refreshProviders();
		}
	}
}

/**
 * Opens the NexusIDE Agents window: a separate window that shows a chat in
 * Agent mode. When it is already open, it is brought to the front instead.
 */
export async function openNexusAgentsWindow(accessor: ServicesAccessor): Promise<void> {
	const editorService = accessor.get(IEditorService);
	const hostService = accessor.get(IHostService);

	const input = NexusAgentsEditorInput.instance;
	const existing = editorService.findEditors(input.resource)[0];
	const pane = await editorService.openEditor(input, { pinned: true }, existing?.groupId ?? AUX_WINDOW_GROUP);
	if (pane) {
		await hostService.focus(getWindowById(pane.group.windowId, true).window);
	}
}

/** Brings the main NexusIDE window, with the code, to the front. */
export function showNexusIDEWindow(accessor: ServicesAccessor): Promise<void> {
	return accessor.get(IHostService).focus(mainWindow);
}
