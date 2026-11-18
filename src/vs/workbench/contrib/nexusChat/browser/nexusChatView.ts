/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NexusIDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/nexusChat.css';
import { $, addDisposableListener, append, clearNode, getWindow, reset, scheduleAtNextAnimationFrame } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableMap, DisposableStore, IDisposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { AIExecutionMode, AIPermissionDecision, IAIProviderInfo, IAIService } from '../../../../platform/ai/common/ai.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IMarkdownRendererService } from '../../../../platform/markdown/browser/markdownRenderer.js';
import { IMarkerService, MarkerSeverity } from '../../../../platform/markers/common/markers.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { INexusChatAttachment, INexusChatMessage, NexusChatModel, NexusChatPart, pickProvider } from '../common/nexusChatModel.js';
import { formatProblems } from '../common/nexusChatProblems.js';
import { INexusChatCodeBlockHost, NexusChatCodeBlockRenderer } from './nexusChatCodeBlock.js';
import { getPreviewKind, NexusChatPreviews } from './nexusChatPreview.js';

export const NEXUS_CHAT_VIEW_CONTAINER_ID = 'workbench.view.nexusChat';
export const NEXUS_CHAT_VIEW_ID = 'workbench.view.nexusChat.chat';

/** Modes the panel offers. */
const PANEL_MODES: readonly { readonly mode: AIExecutionMode; readonly label: string }[] = [
	{ mode: 'ask', label: localize('nexusChat.mode.ask', "Ask") },
	{ mode: 'plan', label: localize('nexusChat.mode.plan', "Plan") },
	{ mode: 'agent', label: localize('nexusChat.mode.agent', "Agent") },
	// Shown as Fix so it is not confused with the debugger in the Run and Debug view.
	{ mode: 'debug', label: localize('nexusChat.mode.fix', "Fix") },
];

/** Distance from the bottom, in pixels, within which new text keeps the list scrolled to the end. */
const STICK_TO_BOTTOM_THRESHOLD = 24;

/** The elements of one part, and the part they currently show. */
interface IPartElements {
	readonly root: HTMLElement;
	part: NexusChatPart;
	/** `streaming` is true while the reply is still arriving. */
	update(part: NexusChatPart, canAnswer: boolean, streaming: boolean): void;
}

/** The elements of one message. Disposing it removes them and their buttons. */
class MessageElements implements IDisposable {
	readonly disposables = new DisposableStore();
	readonly parts: IPartElements[] = [];

	constructor(
		readonly root: HTMLElement,
		readonly body: HTMLElement,
		readonly status: HTMLElement,
		/** Assistant text is rendered as markdown, user text as plain text. */
		readonly markdown: boolean,
	) { }

	dispose(): void {
		this.disposables.dispose();
		this.root.remove();
	}
}

/**
 * The NexusIDE chat panel: a message list, a prompt box, mode and provider
 * pickers and a Send/Stop button. Replies are rendered as markdown; their
 * code blocks get Copy, Insert, Save and Open buttons, and HTML and SVG
 * blocks also get a live Preview.
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
	private readonly messageElements = this._register(new DisposableMap<string, MessageElements>());
	/** Permission requests whose answer is being sent, so their buttons stay disabled. */
	private readonly answering = new Set<string>();
	private readonly codeBlockRenderer: NexusChatCodeBlockRenderer;
	private readonly previews: NexusChatPreviews;
	private readonly codeBlockHost: INexusChatCodeBlockHost = {
		showNotice: message => this.showNotice(message),
		getPreviewAction: (languageAlias, languageId, code) => {
			const kind = getPreviewKind(languageAlias, languageId);
			return kind ? () => this.previews.open(kind, code) : undefined;
		},
	};

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
		@IMarkdownRendererService private readonly markdownRendererService: IMarkdownRendererService,
		@IMarkerService private readonly markerService: IMarkerService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this.codeBlockRenderer = instantiationService.createInstance(NexusChatCodeBlockRenderer);
		this.previews = this._register(instantiationService.createInstance(NexusChatPreviews));
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
		this.emptyState.textContent = localize('nexusChat.empty', "Ask about the code in your open folder. In Ask and Plan mode the AI can only read files. In Agent mode it can also edit files and run commands, after you allow each one. Fix mode does the same to find and fix a bug, and sends the errors from the Problems panel with your message.");

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

		const mode = this.selectedMode();
		const folder = this.workingFolder();
		if ((mode === 'agent' || mode === 'debug') && folder === undefined) {
			this.showNotice(mode === 'debug'
				? localize('nexusChat.fixNeedsFolder', "Fix mode needs a folder on disk. Open a folder, then try again.")
				: localize('nexusChat.agentNeedsFolder', "Agent mode needs a folder on disk. Open a folder, then try again."));
			return;
		}

		const prompt = this.input.value;
		const attachment = mode === 'debug' && folder ? this.problemsAttachment(folder) : undefined;
		const result = await this.model.send(prompt, { mode, providerId: provider.id, workingDirectory: folder?.fsPath, attachment });
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

	private async answerPermission(requestId: string, decision: AIPermissionDecision): Promise<void> {
		if (this.answering.has(requestId)) {
			return;
		}
		this.answering.add(requestId);
		this.renderMessages();
		try {
			const result = await this.model.respondToPermission(requestId, decision);
			if (!result.ok) {
				this.showNotice(localize('nexusChat.answerFailed', "Could not send your answer: {0}", result.error));
			}
		} finally {
			this.answering.delete(requestId);
			if (!this._store.isDisposed) {
				this.renderMessages();
			}
		}
	}

	private selectedMode(): AIExecutionMode {
		const value = this.modeSelect?.value;
		return PANEL_MODES.find(entry => entry.mode === value)?.mode ?? 'ask';
	}

	/** The first workspace folder on disk, which the provider uses as its working directory. */
	private workingFolder(): URI | undefined {
		const folder = this.workspaceContextService.getWorkspace().folders[0];
		return folder?.uri.scheme === Schemas.file ? folder.uri : undefined;
	}

	/** The errors and warnings of the Problems panel inside `folder`, or `undefined` when there are none. */
	private problemsAttachment(folder: URI): INexusChatAttachment | undefined {
		const problems = formatProblems(this.markerService.read({ severities: MarkerSeverity.Error | MarkerSeverity.Warning }), folder);
		if (!problems) {
			return undefined;
		}
		const label = problems.included === 1
			? localize('nexusChat.oneProblemIncluded', "Included 1 problem from the Problems panel.")
			: localize('nexusChat.problemsIncluded', "Included {0} problems from the Problems panel.", problems.included);
		return { label, text: problems.text };
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
		for (const id of [...this.messageElements.keys()]) {
			if (!shown.has(id)) {
				this.messageElements.deleteAndDispose(id);
			}
		}

		if (stickToBottom) {
			list.scrollTop = list.scrollHeight;
		}
		this.updateSendButton();
	}

	private updateMessageElements(elements: MessageElements, message: INexusChatMessage): void {
		// Parts are only appended or replaced, so the element at an index always shows the part at that index.
		const streaming = message.state === 'streaming';
		message.parts.forEach((part, index) => {
			const canAnswer = streaming && part.kind === 'permission' && part.state === 'pending' && !this.answering.has(part.requestId);
			const existing = elements.parts[index];
			if (existing && existing.part.kind === part.kind) {
				existing.update(part, canAnswer, streaming);
			} else {
				existing?.root.remove();
				const created = this.createPartElements(elements, part, canAnswer, streaming);
				if (existing) {
					elements.body.insertBefore(created.root, elements.body.children[index] ?? null);
				}
				elements.parts[index] = created;
			}
		});
		const status = messageStatus(message);
		elements.status.textContent = status ?? '';
		elements.status.style.display = status ? '' : 'none';
		elements.root.classList.toggle('failed', message.state === 'failed');
	}

	private createPartElements(message: MessageElements, part: NexusChatPart, canAnswer: boolean, streaming: boolean): IPartElements {
		switch (part.kind) {
			case 'text':
				return message.markdown ? this.createMarkdownPart(message, part, streaming) : createTextPart(message.body, part);
			case 'tool':
				return createToolPart(message.body, part);
			case 'permission':
				// A card always shows the same request: its part is only replaced to change the state.
				return createPermissionPart(message.body, part, canAnswer, message.disposables, decision => this.answerPermission(part.requestId, decision));
		}
	}

	/**
	 * Renders a text part as markdown. Model output is untrusted: HTML in it is
	 * shown as text, command links do not run and remote images are not loaded,
	 * so a reply cannot send data to a server just by being shown. While the
	 * reply streams, the markdown is rendered at most once per animation frame.
	 */
	private createMarkdownPart(message: MessageElements, initial: NexusChatPart & { readonly kind: 'text' }, streaming: boolean): IPartElements {
		const root = append(message.body, $('.nexus-chat-message-text.nexus-chat-markdown'));
		// Holds the current rendering and the buttons of its code blocks.
		const rendering = message.disposables.add(new MutableDisposable<DisposableStore>());
		const nextFrame = message.disposables.add(new MutableDisposable());
		let renderedText: string | undefined;

		const render = (text: string) => {
			const store = new DisposableStore();
			rendering.value = store;
			const rendered = store.add(this.markdownRendererService.render({ value: text, isTrusted: false, supportHtml: false }, {
				codeBlockRenderer: (languageAlias, code) => this.codeBlockRenderer.render(languageAlias, code, store, this.codeBlockHost),
				sanitizerConfig: { replaceWithPlaintext: true, remoteImageIsAllowed: () => false },
			}));
			reset(root, rendered.element);
			renderedText = text;
		};

		const elements: IPartElements = {
			root,
			part: initial,
			update(part, _canAnswer, isStreaming) {
				elements.part = part;
				if (part.kind !== 'text' || part.text === renderedText) {
					return;
				}
				if (!isStreaming) {
					nextFrame.clear();
					render(part.text);
				} else if (!nextFrame.value) {
					render(part.text);
					// Text that arrives before the next frame is rendered then, in one go.
					nextFrame.value = scheduleAtNextAnimationFrame(getWindow(root), () => {
						nextFrame.clear();
						elements.update(elements.part, false, true);
					});
				}
			},
		};
		elements.update(initial, false, streaming);
		return elements;
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

function createMessageElements(list: HTMLElement, message: INexusChatMessage): MessageElements {
	const root = append(list, $(`.nexus-chat-message.${message.role}`));
	const role = append(root, $('.nexus-chat-message-role'));
	role.textContent = message.role === 'user'
		? localize('nexusChat.you', "You")
		: localize('nexusChat.assistant', "AI");
	const body = append(root, $('.nexus-chat-message-body'));
	const status = append(root, $('.nexus-chat-message-status'));
	return new MessageElements(root, body, status, message.role === 'assistant');
}

// These parts are rendered with textContent: model and tool output is never interpreted as HTML.

function createTextPart(container: HTMLElement, initial: NexusChatPart & { readonly kind: 'text' }): IPartElements {
	const root = append(container, $('.nexus-chat-message-text'));
	const elements: IPartElements = {
		root,
		part: initial,
		update(part) {
			if (part.kind === 'text' && root.textContent !== part.text) {
				root.textContent = part.text;
			}
			elements.part = part;
		},
	};
	elements.update(initial, false, false);
	return elements;
}

function createToolPart(container: HTMLElement, initial: NexusChatPart & { readonly kind: 'tool' }): IPartElements {
	const root = append(container, $('.nexus-chat-tool'));
	const icon = append(root, $('span'));
	const label = append(root, $('span.nexus-chat-tool-label'));
	const elements: IPartElements = {
		root,
		part: initial,
		update(part) {
			if (part.kind === 'tool') {
				icon.className = ThemeIcon.asClassName(part.failed ? Codicon.error : Codicon.tools);
				label.textContent = part.failed
					? localize('nexusChat.toolFailed', "{0} (failed or denied)", part.summary)
					: part.summary;
				root.classList.toggle('failed', part.failed);
			}
			elements.part = part;
		},
	};
	elements.update(initial, false, false);
	return elements;
}

function createPermissionPart(container: HTMLElement, initial: NexusChatPart & { readonly kind: 'permission' }, canAnswer: boolean, disposables: DisposableStore, answer: (decision: AIPermissionDecision) => Promise<void>): IPartElements {
	const root = append(container, $('.nexus-chat-permission', { role: 'group' }));
	const question = append(root, $('.nexus-chat-permission-question'));
	question.textContent = localize('nexusChat.permissionQuestion', "Allow the AI to do this?");
	const summary = append(root, $('.nexus-chat-permission-summary'));
	const detail = append(root, $('pre.nexus-chat-permission-detail'));
	const actions = append(root, $('.nexus-chat-permission-actions'));
	const allow = disposables.add(new Button(actions, { ...defaultButtonStyles, small: true }));
	allow.label = localize('nexusChat.allow', "Allow");
	allow.element.classList.add('nexus-chat-allow');
	disposables.add(allow.onDidClick(() => void answer('allow')));
	const deny = disposables.add(new Button(actions, { ...defaultButtonStyles, small: true, secondary: true }));
	deny.label = localize('nexusChat.deny', "Deny");
	deny.element.classList.add('nexus-chat-deny');
	disposables.add(deny.onDidClick(() => void answer('deny')));
	const outcome = append(root, $('.nexus-chat-permission-outcome'));

	const elements: IPartElements = {
		root,
		part: initial,
		update(part, enabled) {
			if (part.kind !== 'permission') {
				return;
			}
			elements.part = part;
			root.setAttribute('aria-label', localize('nexusChat.permissionLabel', "Permission request: {0}", part.summary));
			summary.textContent = part.summary;
			// The detail is only shown when it adds something, for example the full command.
			const showDetail = part.detail !== undefined && part.detail !== part.summary;
			detail.textContent = showDetail ? part.detail ?? '' : '';
			detail.style.display = showDetail ? '' : 'none';
			allow.enabled = enabled;
			deny.enabled = enabled;
			actions.style.display = part.state === 'pending' ? '' : 'none';
			outcome.textContent = part.state === 'allowed'
				? localize('nexusChat.allowed', "Allowed.")
				: part.state === 'denied' ? localize('nexusChat.denied', "Denied.") : '';
			outcome.style.display = part.state === 'pending' ? 'none' : '';
			root.classList.toggle('pending', part.state === 'pending');
			root.classList.toggle('denied', part.state === 'denied');
		},
	};
	elements.update(initial, canAnswer, false);
	return elements;
}

function messageStatus(message: INexusChatMessage): string | undefined {
	const parts: string[] = [];
	switch (message.state) {
		case 'streaming':
			if (message.parts.length === 0) {
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
	if (message.attachmentLabel) {
		parts.push(message.attachmentLabel);
	}
	return parts.length > 0 ? parts.join(' ') : undefined;
}
