/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NexusIDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/nexusChat.css';
import { $, addDisposableListener, append, clearNode } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Schemas } from '../../../../base/common/network.js';
import { localize } from '../../../../nls.js';
import { AIExecutionMode, IAIProviderInfo, IAIService } from '../../../../platform/ai/common/ai.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { INexusChatMessage, NexusChatModel, pickProvider } from '../common/nexusChatModel.js';

export const NEXUS_CHAT_VIEW_CONTAINER_ID = 'workbench.view.nexusChat';
export const NEXUS_CHAT_VIEW_ID = 'workbench.view.nexusChat.chat';

/** Modes the panel offers. Agent and Debug wait for an approval UI. */
const PANEL_MODES: readonly { readonly mode: AIExecutionMode; readonly label: string }[] = [
	{ mode: 'ask', label: localize('nexusChat.mode.ask', "Ask") },
	{ mode: 'plan', label: localize('nexusChat.mode.plan', "Plan") },
];

/** Distance from the bottom, in pixels, within which new text keeps the list scrolled to the end. */
const STICK_TO_BOTTOM_THRESHOLD = 24;

interface IMessageElements {
	readonly root: HTMLElement;
	readonly text: HTMLElement;
	readonly status: HTMLElement;
}

/**
 * The NexusIDE chat panel: a message list, a prompt box, mode and provider
 * pickers and a Send/Stop button. Replies are shown as plain text.
 */
export class NexusChatViewPane extends ViewPane {

	private readonly model: NexusChatModel;

	private providers: readonly IAIProviderInfo[] = [];
	private selectedProviderId: string | undefined;
	private providersLoaded = false;

	private root: HTMLElement | undefined;
	private messageList: HTMLElement | undefined;
	private emptyState: HTMLElement | undefined;
	private input: HTMLTextAreaElement | undefined;
	private modeSelect: HTMLSelectElement | undefined;
	private providerSelect: HTMLSelectElement | undefined;
	private sendButton: Button | undefined;
	private notice: HTMLElement | undefined;
	private readonly messageElements = new Map<string, IMessageElements>();

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
		@IAIService private readonly aiService: IAIService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this.model = this._register(instantiationService.createInstance(NexusChatModel));
		this._register(this.model.onDidChange(() => this.renderMessages()));
		this._register(this.onDidChangeBodyVisibility(visible => {
			if (visible) {
				void this.refreshProviders();
			}
		}));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		const root = this.root = append(container, $('.nexus-chat'));

		const messageList = this.messageList = append(root, $('.nexus-chat-messages', { role: 'log', 'aria-live': 'polite', tabIndex: 0 }));
		messageList.setAttribute('aria-label', localize('nexusChat.messages', "Chat messages"));
		this.emptyState = append(messageList, $('.nexus-chat-empty'));
		this.emptyState.textContent = localize('nexusChat.empty', "Ask about the code in your open folder. In Ask and Plan mode the AI can read files but cannot change them.");

		const inputArea = append(root, $('.nexus-chat-input'));
		const input = this.input = append(inputArea, $('textarea.nexus-chat-prompt')) as HTMLTextAreaElement;
		input.rows = 3;
		input.placeholder = localize('nexusChat.placeholder', "Message (Enter to send, Shift+Enter for a new line)");
		input.setAttribute('aria-label', localize('nexusChat.prompt', "Chat message"));
		this._register(addDisposableListener(input, 'keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
				e.preventDefault();
				void this.submit();
			}
		}));

		const controls = append(inputArea, $('.nexus-chat-controls'));

		const modeSelect = this.modeSelect = append(controls, $('select.nexus-chat-select')) as HTMLSelectElement;
		modeSelect.setAttribute('aria-label', localize('nexusChat.modeLabel', "Mode"));
		for (const { mode, label } of PANEL_MODES) {
			const option = append(modeSelect, $('option')) as HTMLOptionElement;
			option.value = mode;
			option.textContent = label;
		}

		const providerSelect = this.providerSelect = append(controls, $('select.nexus-chat-select.nexus-chat-provider')) as HTMLSelectElement;
		providerSelect.setAttribute('aria-label', localize('nexusChat.providerLabel', "AI provider"));
		this._register(addDisposableListener(providerSelect, 'change', () => {
			this.selectedProviderId = providerSelect.value || undefined;
		}));

		const sendButton = this.sendButton = this._register(new Button(controls, { ...defaultButtonStyles, small: true }));
		sendButton.element.classList.add('nexus-chat-send');
		this._register(sendButton.onDidClick(() => {
			if (this.model.isRunning) {
				void this.stop();
			} else {
				void this.submit();
			}
		}));

		this.notice = append(inputArea, $('.nexus-chat-notice', { role: 'status' }));

		this.renderProviders();
		this.renderMessages();
		void this.refreshProviders();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		if (this.root) {
			this.root.style.height = `${height}px`;
		}
	}

	override focus(): void {
		super.focus();
		this.input?.focus();
	}

	/** Starts a new, empty chat. A running reply is cancelled. */
	newChat(): void {
		this.model.clear();
		this.showNotice(undefined);
		this.focus();
	}

	private async submit(): Promise<void> {
		if (!this.input || this.model.isRunning) {
			return;
		}
		if (!this.providersLoaded || !pickProvider(this.providers, this.selectedProviderId)) {
			await this.refreshProviders();
		}
		const provider = pickProvider(this.providers, this.selectedProviderId);
		if (!provider) {
			this.showNotice(localize('nexusChat.noProvider', "No AI provider is available. Install the Claude Code CLI, sign in by running `claude` once in a terminal, then try again."));
			return;
		}

		const prompt = this.input.value;
		const result = await this.model.send(prompt, {
			mode: this.selectedMode(),
			providerId: provider.id,
			workingDirectory: this.workingDirectory(),
		});
		if (!result.ok) {
			this.showNotice(result.error);
			return;
		}
		this.showNotice(undefined);
		if (this.input.value === prompt) {
			this.input.value = '';
		}
	}

	private async stop(): Promise<void> {
		const result = await this.model.stop();
		if (!result.ok) {
			this.showNotice(localize('nexusChat.stopFailed', "Could not stop the reply: {0}", result.error));
		}
	}

	private selectedMode(): AIExecutionMode {
		const value = this.modeSelect?.value;
		return PANEL_MODES.find(entry => entry.mode === value)?.mode ?? 'ask';
	}

	/** The first workspace folder on disk, which the provider uses as its working directory. */
	private workingDirectory(): string | undefined {
		const folder = this.workspaceContextService.getWorkspace().folders[0];
		return folder?.uri.scheme === Schemas.file ? folder.uri.fsPath : undefined;
	}

	private async refreshProviders(): Promise<void> {
		let providers: readonly IAIProviderInfo[] = [];
		let error: string | undefined;
		try {
			const result = await this.aiService.listProviders();
			if (result.ok) {
				providers = result.value;
			} else {
				error = result.error;
			}
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
		if (this._store.isDisposed) {
			return;
		}
		this.providers = providers;
		this.providersLoaded = error === undefined;
		this.selectedProviderId = pickProvider(providers, this.selectedProviderId)?.id;
		this.renderProviders();
		if (error !== undefined) {
			this.showNotice(localize('nexusChat.providersFailed', "Could not load the AI providers: {0}", error));
		}
	}

	private renderProviders(): void {
		const select = this.providerSelect;
		if (!select) {
			return;
		}
		clearNode(select);
		if (this.providers.length === 0) {
			const option = append(select, $('option')) as HTMLOptionElement;
			option.value = '';
			option.textContent = this.providersLoaded
				? localize('nexusChat.noProviders', "No providers")
				: localize('nexusChat.loadingProviders', "Loading…");
		}
		for (const provider of this.providers) {
			const option = append(select, $('option')) as HTMLOptionElement;
			option.value = provider.id;
			option.disabled = !provider.available;
			option.textContent = provider.available
				? provider.displayName
				: localize('nexusChat.providerUnavailable', "{0} (not available)", provider.displayName);
		}
		select.value = this.selectedProviderId ?? '';
	}

	private renderMessages(): void {
		const list = this.messageList;
		if (!list || !this.emptyState) {
			return;
		}
		const stickToBottom = list.scrollHeight - list.scrollTop - list.clientHeight <= STICK_TO_BOTTOM_THRESHOLD;

		const messages = this.model.messages;
		this.emptyState.style.display = messages.length === 0 ? '' : 'none';

		const shown = new Set<string>();
		for (const message of messages) {
			shown.add(message.id);
			let elements = this.messageElements.get(message.id);
			if (!elements) {
				elements = createMessageElements(list, message);
				this.messageElements.set(message.id, elements);
			}
			this.updateMessageElements(elements, message);
		}
		for (const [id, elements] of this.messageElements) {
			if (!shown.has(id)) {
				elements.root.remove();
				this.messageElements.delete(id);
			}
		}

		if (stickToBottom) {
			list.scrollTop = list.scrollHeight;
		}
		this.updateSendButton();
	}

	private updateMessageElements(elements: IMessageElements, message: INexusChatMessage): void {
		if (elements.text.textContent !== message.text) {
			elements.text.textContent = message.text;
		}
		const status = messageStatus(message);
		elements.status.textContent = status ?? '';
		elements.status.style.display = status ? '' : 'none';
		elements.root.classList.toggle('failed', message.state === 'failed');
	}

	private updateSendButton(): void {
		if (!this.sendButton) {
			return;
		}
		const running = this.model.isRunning;
		this.sendButton.label = running ? localize('nexusChat.stop', "Stop") : localize('nexusChat.send', "Send");
		this.sendButton.element.classList.toggle('running', running);
	}

	private showNotice(text: string | undefined): void {
		if (this.notice) {
			this.notice.textContent = text ?? '';
			this.notice.style.display = text ? 'block' : 'none';
		}
	}
}

function createMessageElements(list: HTMLElement, message: INexusChatMessage): IMessageElements {
	const root = append(list, $(`.nexus-chat-message.${message.role}`));
	const role = append(root, $('.nexus-chat-message-role'));
	role.textContent = message.role === 'user'
		? localize('nexusChat.you', "You")
		: localize('nexusChat.assistant', "AI");
	// Plain text only: model output is never interpreted as HTML.
	const text = append(root, $('.nexus-chat-message-text'));
	const status = append(root, $('.nexus-chat-message-status'));
	return { root, text, status };
}

function messageStatus(message: INexusChatMessage): string | undefined {
	const parts: string[] = [];
	switch (message.state) {
		case 'streaming':
			if (message.text.length === 0) {
				parts.push(localize('nexusChat.thinking', "Thinking…"));
			}
			break;
		case 'cancelled':
			parts.push(localize('nexusChat.stopped', "Stopped."));
			break;
		case 'failed':
			parts.push(localize('nexusChat.failed', "Error: {0}", message.error ?? ''));
			break;
	}
	if (message.warning) {
		parts.push(message.warning);
	}
	return parts.length > 0 ? parts.join(' ') : undefined;
}
