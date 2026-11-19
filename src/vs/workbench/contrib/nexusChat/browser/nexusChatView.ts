/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NexusIDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AIExecutionMode } from '../../../../platform/ai/common/ai.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { INexusOpenChat } from '../common/nexusOpenChat.js';
import { NexusChatWidget } from './nexusChatWidget.js';

export const NEXUS_CHAT_VIEW_CONTAINER_ID = 'workbench.view.nexusChat';
export const NEXUS_CHAT_VIEW_ID = 'workbench.view.nexusChat.chat';

/**
 * The NexusIDE chat panel in the side bar. It shows a {@link NexusChatWidget},
 * which holds the conversation and all of the chat's behavior.
 */
export class NexusChatViewPane extends ViewPane {

	private widget: NexusChatWidget | undefined;
	/** Applied once the widget exists, if setMode ran first. */
	private pendingMode: AIExecutionMode | undefined;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this._register(this.onDidChangeBodyVisibility(visible => {
			if (visible) {
				void this.widget?.refreshProviders();
			}
		}));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this.widget = this._register(this.instantiationService.createInstance(NexusChatWidget, container, {}));
		if (this.pendingMode) {
			this.widget.setMode(this.pendingMode);
			this.pendingMode = undefined;
		}
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this.widget?.layout(height);
	}

	override focus(): void {
		super.focus();
		this.widget?.focus();
	}

	/** Starts a new, empty chat. A running reply is cancelled. */
	newChat(): void {
		this.widget?.newChat();
		this.focus();
	}

	/** Selects a mode. `debug` stays labeled Fix in the chat. */
	setMode(mode: AIExecutionMode): void {
		if (this.widget) {
			this.widget.setMode(mode);
		} else {
			this.pendingMode = mode;
		}
	}

	/** The open chat, for the command palette. */
	getOpenChat(): INexusOpenChat | undefined {
		return this.widget?.getOpenChat();
	}
}
