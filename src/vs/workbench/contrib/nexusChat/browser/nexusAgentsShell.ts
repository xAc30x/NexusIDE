/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NexusIDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, clearNode } from '../../../../base/browser/dom.js';
import { Disposable, IDisposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import Severity from '../../../../base/common/severity.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IDialogService, IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { folderRows, GITHUB_TRIGGERS, NexusFolderConversation, NexusTrigger, SLACK_TRIGGERS, visibleAutomations, visibleConversations, visibleProjects } from '../common/nexusAgentsDocument.js';
import { INexusAgentsDocumentService } from './nexusAgentsDocumentService.js';
import { INexusChatTranscript, NexusChatWidget } from './nexusChatWidget.js';

/**
 * The one Agents window: folder conversations, Projects, and Automations.
 *
 * The chat widget stays a view of one local conversation. This shell decides
 * what is selected and stores the transcript. It does not run a remote agent.
 */
export class NexusAgentsShell extends Disposable {

	private readonly root: HTMLElement;
	private readonly list: HTMLElement;
	private readonly toolbar: HTMLElement;
	private readonly status: HTMLElement;
	private readonly chat: HTMLElement;
	private readonly files: HTMLElement;
	private readonly widget = this._register(new MutableDisposable<NexusChatWidget>());
	private readonly transcriptListener = this._register(new MutableDisposable<IDisposable>());
	private listSignature = '';
	private shownKey = '';
	private trustButton: HTMLButtonElement | undefined;

	constructor(
		container: HTMLElement,
		@INexusAgentsDocumentService private readonly documents: INexusAgentsDocumentService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IDialogService private readonly dialogService: IDialogService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@IFileService private readonly fileService: IFileService,
		@IEditorService private readonly editorService: IEditorService,
		@IWorkspaceTrustManagementService private readonly workspaceTrustManagementService: IWorkspaceTrustManagementService,
	) {
		super();
		this.root = append(container, $('.nexus-agents'));
		this.list = append(this.root, $('.nexus-agents-list'));
		const main = append(this.root, $('.nexus-agents-main'));
		this.toolbar = append(main, $('.nexus-agents-toolbar'));
		this.status = append(main, $('.nexus-agents-status'));
		this.chat = append(main, $('.nexus-agents-chat'));
		this.files = append(main, $('.nexus-agents-files'));
		this._register(this.documents.onDidChange(() => this.onDocumentChange()));
		this._register(this.workspaceTrustManagementService.onDidChangeTrust(() => void this.refreshTrustButton()));
		this._register(this.workspaceTrustManagementService.onDidChangeTrustedFolders(() => void this.refreshTrustButton()));
		this.updateList();
	}

	/** Selects the folder's local conversation when the editor was opened for one. */
	show(folder: URI | undefined): void {
		if (folder) {
			this.documents.ensureLocalConversation(folder);
		}
		this.onDocumentChange();
	}

	layout(height: number): void {
		this.root.style.height = `${height}px`;
		this.widget.value?.layout(height);
	}

	focus(): void {
		this.widget.value?.focus() ?? this.root.querySelector<HTMLTextAreaElement>('.nexus-agents-remote-prompt')?.focus();
	}

	refresh(): void {
		void this.widget.value?.refreshProviders();
	}

	private onDocumentChange(): void {
		this.updateList();
		const key = this.mainKey();
		if (key !== this.shownKey) {
			this.shownKey = key;
			this.mountMain();
			return;
		}
		if (this.remoteConversation()) {
			this.renderRemoteMessages();
		}
	}

	private mainKey(): string {
		const selection = this.documents.snapshot.selection;
		if (selection.kind === 'conversation') {
			const conversation = this.conversation(selection.id);
			return `conversation:${selection.id}:${conversation?.runtime ?? ''}`;
		}
		if (selection.kind === 'agent') {
			return `agent:${selection.projectId}:${selection.agentId}`;
		}
		return `${selection.kind}:${'id' in selection ? selection.id : ''}`;
	}

	private updateList(): void {
		const signature = this.listKey();
		if (signature === this.listSignature) {
			return;
		}
		this.listSignature = signature;
		clearNode(this.list);
		this.renderAccount();
		this.renderConversations();
		this.renderProjects();
		this.renderAutomations();
		const customize = append(this.list, $('.nexus-agents-customize'));
		customize.textContent = localize('nexusAgents.customizeLater', "Customize is not available yet.");
	}

	private listKey(): string {
		const document = this.documents.snapshot;
		return JSON.stringify({
			signedIn: document.signedIn,
			github: document.githubConnected,
			slack: document.slackConnected,
			pulls: document.alwaysCreatePullRequests,
			selection: document.selection,
			conversations: visibleConversations(document).map(conversation => ({ id: conversation.id, title: conversation.title, runtime: conversation.runtime, folder: conversation.folder })),
			projects: visibleProjects(document).map(project => ({ id: project.id, name: project.name, agents: project.agents.map(agent => agent.id + agent.status) })),
			automations: visibleAutomations(document).map(automation => automation.id + automation.name),
		});
	}

	private renderAccount(): void {
		const document = this.documents.snapshot;
		if (!document.signedIn) {
			this.button(this.list, 'nexus-agents-sign-in', localize('nexusAgents.signIn', "Sign In"), () => this.report(this.documents.signIn()));
			return;
		}
		if (!document.githubConnected) {
			this.button(this.list, 'nexus-agents-github', localize('nexusAgents.github', "Connect GitHub"), () => this.report(this.documents.connectGitHub()));
		}
		if (!document.slackConnected) {
			this.button(this.list, 'nexus-agents-slack', localize('nexusAgents.slack', "Connect Slack"), () => this.report(this.documents.connectSlack()));
		}
		const pulls = append(this.list, $('label.nexus-agents-pulls'));
		const checkbox = append(pulls, $('input')) as HTMLInputElement;
		checkbox.type = 'checkbox';
		checkbox.checked = document.alwaysCreatePullRequests;
		checkbox.addEventListener('change', () => this.documents.setAlwaysCreatePullRequests(checkbox.checked));
		pulls.append(localize('nexusAgents.alwaysPr', "Always create pull requests"));
	}

	private renderConversations(): void {
		append(this.list, $('.nexus-agents-heading')).textContent = localize('nexusAgents.folders', "Folders");
		this.button(this.list, 'nexus-agents-new-conversation', localize('nexusAgents.newConversation', "New Conversation"), () => void this.newConversation());
		for (const row of folderRows(this.documents.snapshot)) {
			const folder = append(this.list, $('.nexus-agents-folder'));
			folder.textContent = row.folder;
			for (const conversation of row.conversations) {
				this.button(this.list, 'nexus-agents-conversation', `${conversation.title} (${conversation.runtime})`, () => {
					this.documents.select({ kind: 'conversation', id: conversation.id });
				});
			}
		}
	}

	private renderProjects(): void {
		if (!this.documents.snapshot.signedIn) {
			return;
		}
		append(this.list, $('.nexus-agents-heading')).textContent = localize('nexusAgents.projects', "Projects");
		const form = append(this.list, $('form.nexus-agents-new-project'));
		const name = this.field(form, localize('nexusAgents.projectName', "Project name"));
		const repository = this.field(form, localize('nexusAgents.repository', "owner/repo"));
		const model = this.field(form, localize('nexusAgents.model', "Model"));
		const submit = append(form, $('button')) as HTMLButtonElement;
		submit.type = 'submit';
		submit.textContent = localize('nexusAgents.createProject', "Create Project");
		form.addEventListener('submit', event => {
			event.preventDefault();
			this.report(this.documents.createProject(name.value, repository.value, model.value));
		});
		for (const project of visibleProjects(this.documents.snapshot)) {
			this.button(this.list, 'nexus-agents-project', project.name, () => this.documents.select({ kind: 'project', id: project.id }));
			for (const agent of project.agents) {
				this.button(this.list, 'nexus-agents-agent', `${agent.branch} (${agent.status})`, () => this.documents.select({ kind: 'agent', projectId: project.id, agentId: agent.id }));
			}
		}
	}

	private renderAutomations(): void {
		if (!this.documents.snapshot.signedIn) {
			return;
		}
		append(this.list, $('.nexus-agents-heading')).textContent = localize('nexusAgents.automations', "Automations");
		const form = append(this.list, $('form.nexus-agents-new-automation'));
		const name = this.field(form, localize('nexusAgents.automationName', "Automation name"));
		const model = this.field(form, localize('nexusAgents.model', "Model"));
		const prompt = this.field(form, localize('nexusAgents.prompt', "Prompt"));
		const repositories = this.field(form, localize('nexusAgents.repositories', "owner/repo, owner/other"));
		const cron = this.field(form, localize('nexusAgents.cron', "Cron"));
		const mcpUrl = this.field(form, localize('nexusAgents.mcpUrl', "MCP server address"));
		const mcpCredential = this.field(form, localize('nexusAgents.mcpCredential', "MCP credential"));
		const trigger = append(form, $('select.nexus-agents-trigger')) as HTMLSelectElement;
		for (const event of ['schedule', 'webhook', ...GITHUB_TRIGGERS, ...SLACK_TRIGGERS.map(event => `slack:${event}`)]) {
			const option = append(trigger, $('option')) as HTMLOptionElement;
			option.value = event;
			option.textContent = event;
		}
		const submit = append(form, $('button')) as HTMLButtonElement;
		submit.type = 'submit';
		submit.textContent = localize('nexusAgents.createAutomation', "Create Automation");
		form.addEventListener('submit', event => {
			event.preventDefault();
			const chosen = trigger.value;
			const triggers: NexusTrigger[] = chosen === 'schedule'
				? [{ kind: 'schedule', cron: cron.value }]
				: chosen === 'webhook'
					? [{ kind: 'webhook' }]
					: chosen.startsWith('slack:')
						? [{ kind: 'slack', event: chosen.slice('slack:'.length) as typeof SLACK_TRIGGERS[number] }]
						: [{ kind: 'github', event: chosen as typeof GITHUB_TRIGGERS[number] }];
			const repos = repositories.value.split(',').map(value => value.trim()).filter(value => value.length > 0);
			const mcp = mcpUrl.value.trim().length > 0 ? [{ url: mcpUrl.value.trim(), credential: mcpCredential.value }] : [];
			this.report(this.documents.createAutomation({ name: name.value, prompt: prompt.value, model: model.value, triggers, repositories: repos, mcp }));
		});
		for (const automation of visibleAutomations(this.documents.snapshot)) {
			this.button(this.list, 'nexus-agents-automation', automation.name, () => this.documents.select({ kind: 'automation', id: automation.id }));
		}
	}

	private mountMain(): void {
		this.transcriptListener.clear();
		this.widget.clear();
		clearNode(this.toolbar);
		clearNode(this.chat);
		clearNode(this.files);
		this.trustButton = undefined;
		const selection = this.documents.snapshot.selection;
		if (selection.kind === 'conversation') {
			const conversation = this.conversation(selection.id);
			if (conversation?.runtime === 'local') {
				this.mountLocal(conversation);
			} else if (conversation && this.documents.snapshot.signedIn) {
				this.mountRemote(conversation);
			} else if (conversation) {
				this.chat.textContent = localize('nexusAgents.signInRemote', "Sign in to a NexusIDE account to see this remote conversation.");
			}
			return;
		}
		if (selection.kind === 'project') {
			this.mountProject(selection.id);
			return;
		}
		if (selection.kind === 'agent') {
			this.mountAgent(selection.projectId, selection.agentId);
			return;
		}
		if (selection.kind === 'automation') {
			this.mountAutomation(selection.id);
			return;
		}
		this.chat.textContent = localize('nexusAgents.emptySelection', "Start a conversation for a folder, or sign in to use Projects and Automations.");
	}

	private mountLocal(conversation: NexusFolderConversation): void {
		const folder = conversation.folder ? URI.parse(conversation.folder) : undefined;
		if (folder) {
			this.trustButton = this.button(this.toolbar, 'nexus-agents-trust', localize('nexusAgents.trust', "Trust This Folder"), () => void this.trust(folder));
			this.button(this.toolbar, 'nexus-agents-files-button', localize('nexusAgents.files', "Files"), () => void this.showFiles(folder));
			this.button(this.toolbar, 'nexus-agents-terminal', localize('nexusAgents.terminal', "Terminal"), () => void this.documents.openTerminal(folder));
			void this.refreshTrustButton();
		}
		this.mountMove(conversation);
		const widget = this.widget.value = this.instantiationService.createInstance(NexusChatWidget, this.chat, { initialMode: 'agent', folder });
		widget.restoreTranscript(this.transcriptOf(conversation));
		this.transcriptListener.value = widget.onDidChangeConversation(() => {
			const snapshot = widget.captureTranscript();
			this.documents.saveLocalSnapshot(conversation.id, snapshot.threadId, snapshot.messages, snapshot.running, snapshot.pendingApproval, snapshot.queued, snapshot.steer);
		});
		void widget.deliverWaiting();
		void widget.refreshProviders();
	}

	private mountRemote(conversation: NexusFolderConversation): void {
		this.mountMove(conversation);
		append(this.chat, $('.nexus-agents-transcript'));
		this.renderRemoteMessages();
		const prompt = append(this.chat, $('textarea.nexus-agents-remote-prompt')) as HTMLTextAreaElement;
		prompt.placeholder = localize('nexusAgents.remotePrompt', "Message the remote conversation (Enter to send, Ctrl+Enter to steer)");
		prompt.addEventListener('keydown', event => {
			if (event.key !== 'Enter' || event.shiftKey || event.isComposing) {
				return;
			}
			event.preventDefault();
			const text = prompt.value;
			const current = this.conversation(conversation.id);
			const mode = (event.ctrlKey || event.metaKey) && (current?.running || current?.pendingApproval) ? 'steer' : 'queue';
			if (this.report(this.documents.followUp(conversation.id, text, mode))) {
				prompt.value = '';
			}
		});
	}

	private mountMove(conversation: NexusFolderConversation): void {
		const repository = this.field(this.toolbar, localize('nexusAgents.moveRepository', "owner/repo"));
		repository.value = conversation.repository ?? '';
		const checkout = append(this.toolbar, $('input.nexus-agents-checkout')) as HTMLInputElement;
		checkout.type = 'checkbox';
		checkout.checked = conversation.repository ? !!this.documents.snapshot.clones[conversation.repository] : false;
		const label = conversation.runtime === 'local'
			? localize('nexusAgents.moveRemote', "Run on NexusIDE")
			: localize('nexusAgents.moveLocal', "Run on this machine");
		this.button(this.toolbar, 'nexus-agents-move', label, () => {
			const target = conversation.runtime === 'local' ? 'remote' : 'local';
			this.report(this.documents.moveConversation(conversation.id, target, repository.value.trim() || undefined, checkout.checked));
		});
	}

	private mountProject(projectId: string): void {
		const project = this.documents.snapshot.projects.find(entry => entry.id === projectId);
		if (!project) {
			return;
		}
		this.chat.textContent = localize('nexusAgents.projectDetail', "{0} coordinates {1}. It starts when you message it, and each message hands the work to an agent on its own branch.", project.name, project.repository);
		const prompt = append(this.chat, $('textarea.nexus-agents-project-prompt')) as HTMLTextAreaElement;
		this.button(this.chat, 'nexus-agents-message-project', localize('nexusAgents.messageProject', "Message Project"), () => {
			if (prompt.value.trim().length === 0) {
				this.status.textContent = localize('nexusAgents.typeMessage', "Type a message first.");
				return;
			}
			this.report(this.documents.messageProject(project.id, prompt.value));
		});
	}

	private mountAgent(projectId: string, agentId: string): void {
		const project = this.documents.snapshot.projects.find(entry => entry.id === projectId);
		const agent = project?.agents.find(entry => entry.id === agentId);
		if (!project || !agent) {
			return;
		}
		const detail = append(this.chat, $('.nexus-agents-agent-detail'));
		detail.textContent = agent.pullRequestUrl
			? localize('nexusAgents.agentPull', "{0} from {1}. {2}", agent.branch, agent.baseBranch, agent.pullRequestUrl)
			: localize('nexusAgents.agentBranch', "{0} from {1}. {2}", agent.branch, agent.baseBranch, agent.status);
	}

	private mountAutomation(id: string): void {
		const automation = this.documents.snapshot.automations.find(entry => entry.id === id);
		if (!automation) {
			return;
		}
		const detail = append(this.chat, $('.nexus-agents-automation-detail'));
		const webhook = automation.webhook ? ` ${automation.webhook.url}` : '';
		detail.textContent = `${automation.name}. ${automation.prompt}.${webhook}`;
	}

	private renderRemoteMessages(): void {
		const conversation = this.remoteConversation();
		const transcript = this.chat.querySelector('.nexus-agents-transcript');
		if (!conversation || !transcript) {
			return;
		}
		transcript.textContent = conversation.messages.map(message => message.text).join('\n');
		if (conversation.queued.length > 0 || conversation.steer) {
			transcript.textContent += `\n${conversation.steer ?? ''}\n${conversation.queued.join('\n')}`;
		}
	}

	private remoteConversation(): NexusFolderConversation | undefined {
		const selection = this.documents.snapshot.selection;
		if (selection.kind !== 'conversation') {
			return undefined;
		}
		const conversation = this.conversation(selection.id);
		return conversation?.runtime === 'remote' ? conversation : undefined;
	}

	private async newConversation(): Promise<void> {
		const folder = (await this.fileDialogService.showOpenDialog({
			canSelectFolders: true,
			canSelectFiles: false,
			canSelectMany: false,
			title: localize('nexusAgents.chooseFolder', "Choose a folder"),
		}))?.[0];
		if (folder) {
			this.documents.startLocalConversation(folder);
		}
	}

	private async trust(folder: URI): Promise<void> {
		const confirmed = await this.dialogService.confirm({
			type: Severity.Warning,
			message: localize('nexusAgents.trustMessage', "Trust this folder?"),
			detail: localize('nexusAgents.trustDetail', "NexusIDE runs the AI in {0}. Trust the folder only if you trust its author, because its settings can run commands.", folder.fsPath),
			primaryButton: localize('nexusAgents.trustButton', "Trust This Folder"),
		});
		if (!confirmed.confirmed) {
			return;
		}
		await this.workspaceTrustManagementService.setUrisTrust([folder], true);
		await this.refreshTrustButton();
	}

	private async refreshTrustButton(): Promise<void> {
		const button = this.trustButton;
		const folder = this.selectedFolder();
		if (!button || !folder) {
			return;
		}
		let trusted = false;
		try {
			trusted = (await this.workspaceTrustManagementService.getUriTrustInfo(folder)).trusted;
		} catch {
			trusted = false;
		}
		button.style.display = trusted ? 'none' : '';
	}

	private async showFiles(folder: URI): Promise<void> {
		clearNode(this.files);
		try {
			const stat = await this.fileService.resolve(folder);
			for (const child of stat.children ?? []) {
				if (child.isDirectory) {
					continue;
				}
				this.button(this.files, 'nexus-agents-file', child.name, () => {
					void this.editorService.openEditor({ resource: child.resource });
				});
			}
		} catch {
			this.status.textContent = localize('nexusAgents.filesFailed', "Could not read the folder.");
		}
	}

	private selectedFolder(): URI | undefined {
		const selection = this.documents.snapshot.selection;
		if (selection.kind !== 'conversation') {
			return undefined;
		}
		const folder = this.conversation(selection.id)?.folder;
		return folder ? URI.parse(folder) : undefined;
	}

	private conversation(id: string): NexusFolderConversation | undefined {
		return this.documents.snapshot.conversations.find(conversation => conversation.id === id);
	}

	private transcriptOf(conversation: NexusFolderConversation): INexusChatTranscript {
		return {
			threadId: conversation.threadId,
			messages: conversation.messages,
			running: false,
			pendingApproval: conversation.pendingApproval,
			queued: conversation.queued,
			...(conversation.steer !== undefined ? { steer: conversation.steer } : {}),
		};
	}

	private report(result: { ok: boolean; error?: string }): boolean {
		this.status.textContent = result.ok ? '' : result.error ?? '';
		return result.ok;
	}

	private field(parent: HTMLElement, placeholder: string): HTMLInputElement {
		const input = append(parent, $('input')) as HTMLInputElement;
		input.type = 'text';
		input.placeholder = placeholder;
		input.setAttribute('aria-label', placeholder);
		return input;
	}

	private button(parent: HTMLElement, className: string, label: string, onClick: () => void): HTMLButtonElement {
		const button = append(parent, $(`button.${className}`)) as HTMLButtonElement;
		button.type = 'button';
		button.textContent = label;
		button.addEventListener('click', onClick);
		return button;
	}
}
