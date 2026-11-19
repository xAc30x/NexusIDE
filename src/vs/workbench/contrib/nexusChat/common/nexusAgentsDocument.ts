/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NexusIDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';

/**
 * The Agents window's saved document.
 *
 * Local transcripts and the sidebar copy of remote items live here, in
 * application storage, outside any repository. The NexusIDE service is the
 * source of truth for remote conversations, Projects, and Automations. This
 * module is that contract: it records runs, branches, and pull requests. It
 * does not call a model and it does not edit files. The chat widget stays a
 * view of a local conversation.
 *
 * A sidebar chat is a different conversation. Parsing drops anything marked
 * as one, so it never appears in this window's list.
 */

export const NEXUS_AGENTS_STORAGE_KEY = 'nexus.agents.document';

export const GITHUB_TRIGGERS = [
	'draft_opened',
	'pull_request_opened',
	'pull_request_pushed',
	'pull_request_merged',
	'push',
	'comment_added',
	'pull_request_label_changed',
	'issue_label_changed',
	'ci_completed',
	'issue_comment',
	'pr_review_comment',
	'pr_review_submitted',
	'review_thread_updated',
	'workflow_run_completed',
] as const;

export type GitHubTriggerName = typeof GITHUB_TRIGGERS[number];

export const SLACK_TRIGGERS = ['message', 'emoji', 'channel_created'] as const;

export type SlackTriggerName = typeof SLACK_TRIGGERS[number];

export type NexusTrigger =
	| { readonly kind: 'schedule'; readonly cron: string }
	| { readonly kind: 'webhook' }
	| { readonly kind: 'github'; readonly event: GitHubTriggerName }
	| { readonly kind: 'slack'; readonly event: SlackTriggerName };

export interface NexusTranscriptMessage {
	readonly role: 'user' | 'assistant';
	readonly text: string;
}

export interface NexusMcpServer {
	readonly url: string;
	/** Stored on the account, with the Automation, so the service can call it while this machine is off. */
	readonly credential: string;
}

export interface NexusFolderConversation {
	readonly id: string;
	readonly origin: 'agents';
	readonly folder?: string;
	readonly runtime: 'local' | 'remote';
	readonly title: string;
	readonly messages: readonly NexusTranscriptMessage[];
	readonly threadId: string;
	readonly running: boolean;
	readonly pendingApproval: boolean;
	readonly queued: readonly string[];
	/** Sent at the next tool boundary, ahead of {@link queued}. */
	readonly steer?: string;
	readonly model?: string;
	readonly repository?: string;
	readonly baseBranch?: string;
	readonly branch?: string;
	readonly pullRequestUrl?: string;
	/**
	 * True after a move to the service. Uncommitted files stay on this machine;
	 * only the transcript moves.
	 */
	readonly leftLocalChanges: boolean;
}

export interface NexusProjectAgent {
	readonly id: string;
	readonly branch: string;
	readonly baseBranch: string;
	/** What the user asked the coordinator to hand off. */
	readonly prompt: string;
	readonly status: 'running' | 'finished';
	readonly pullRequestUrl?: string;
}

export interface NexusProject {
	readonly id: string;
	readonly name: string;
	readonly repository: string;
	readonly model: string;
	readonly agents: readonly NexusProjectAgent[];
}

export interface NexusAutomationRun {
	readonly id: string;
	readonly repository?: string;
	readonly branch?: string;
	readonly baseBranch?: string;
	readonly pullRequestUrl?: string;
}

export interface NexusAutomation {
	readonly id: string;
	readonly name: string;
	readonly prompt: string;
	readonly model: string;
	readonly triggers: readonly NexusTrigger[];
	readonly repositories: readonly string[];
	readonly commentOnPullRequest: boolean;
	readonly sendToSlack: boolean;
	readonly mcp: readonly NexusMcpServer[];
	readonly webhook?: { readonly url: string; readonly key: string };
	readonly active: boolean;
	readonly runs: readonly NexusAutomationRun[];
}

export type NexusSelection =
	| { readonly kind: 'none' }
	| { readonly kind: 'conversation'; readonly id: string }
	| { readonly kind: 'project'; readonly id: string }
	| { readonly kind: 'agent'; readonly projectId: string; readonly agentId: string }
	| { readonly kind: 'automation'; readonly id: string };

export interface NexusOutboxEntry {
	readonly conversationId: string;
	readonly text: string;
}

/** A copy of the service plus the local conversations, as this machine last knew it. */
export interface NexusAgentsDocument {
	/** The service answered the last exchange. Local conversations do not need it. */
	readonly reachable: boolean;
	readonly signedIn: boolean;
	readonly alwaysCreatePullRequests: boolean;
	readonly githubConnected: boolean;
	readonly slackConnected: boolean;
	readonly nextPullRequest: number;
	readonly outbox: readonly NexusOutboxEntry[];
	readonly conversations: readonly NexusFolderConversation[];
	readonly projects: readonly NexusProject[];
	readonly automations: readonly NexusAutomation[];
	readonly selection: NexusSelection;
	/** Parent directory chosen the first time a repository was cloned, keyed by `owner/repo`. */
	readonly cloneParents: Readonly<Record<string, string>>;
	/** Local checkout of a repository, keyed by `owner/repo`. */
	readonly clones: Readonly<Record<string, string>>;
	readonly pendingReview?: { readonly folder: string; readonly base: string; readonly branch: string };
}

export type NexusServiceError = { readonly ok: false; readonly error: string };
export type NexusServiceSuccess<T> = { readonly ok: true; readonly document: NexusAgentsDocument; readonly value: T };
export type NexusServiceResult<T> = NexusServiceSuccess<T> | NexusServiceError;

export function emptyNexusAgentsDocument(): NexusAgentsDocument {
	return {
		reachable: true,
		signedIn: false,
		alwaysCreatePullRequests: true,
		githubConnected: false,
		slackConnected: false,
		nextPullRequest: 1,
		outbox: [],
		conversations: [],
		projects: [],
		automations: [],
		selection: { kind: 'none' },
		cloneParents: {},
		clones: {},
	};
}

const SERVICE_UNREACHABLE = 'The NexusIDE service needs to be reachable to do that.';

export function folderRows(document: NexusAgentsDocument): readonly { readonly folder: string; readonly conversations: readonly NexusFolderConversation[] }[] {
	const rows: { folder: string; conversations: NexusFolderConversation[] }[] = [];
	for (const conversation of visibleConversations(document)) {
		if (!conversation.folder) {
			continue;
		}
		let row = rows.find(entry => entry.folder === conversation.folder);
		if (!row) {
			row = { folder: conversation.folder, conversations: [] };
			rows.push(row);
		}
		row.conversations.push(conversation);
	}
	return rows;
}

export function visibleConversations(document: NexusAgentsDocument): readonly NexusFolderConversation[] {
	return document.conversations.filter(conversation => conversation.origin === 'agents' && (conversation.runtime === 'local' || document.signedIn));
}

export function visibleProjects(document: NexusAgentsDocument): readonly NexusProject[] {
	return document.signedIn ? document.projects : [];
}

export function visibleAutomations(document: NexusAgentsDocument): readonly NexusAutomation[] {
	return document.signedIn ? document.automations : [];
}

export function setReachable(document: NexusAgentsDocument, reachable: boolean): NexusAgentsDocument {
	if (!reachable) {
		return { ...document, reachable };
	}
	return flushOutbox({ ...document, reachable: true });
}

export function signIn(document: NexusAgentsDocument): NexusServiceResult<void> {
	if (!document.reachable) {
		return { ok: false, error: SERVICE_UNREACHABLE };
	}
	return { ok: true, document: { ...document, signedIn: true }, value: undefined };
}

export function connectGitHub(document: NexusAgentsDocument): NexusServiceResult<void> {
	if (!document.reachable || !document.signedIn) {
		return { ok: false, error: document.reachable ? 'Sign in to a NexusIDE account first.' : SERVICE_UNREACHABLE };
	}
	return { ok: true, document: { ...document, githubConnected: true }, value: undefined };
}

export function connectSlack(document: NexusAgentsDocument): NexusServiceResult<void> {
	if (!document.reachable || !document.signedIn) {
		return { ok: false, error: document.reachable ? 'Sign in to a NexusIDE account first.' : SERVICE_UNREACHABLE };
	}
	return { ok: true, document: { ...document, slackConnected: true }, value: undefined };
}

export function setAlwaysCreatePullRequests(document: NexusAgentsDocument, enabled: boolean): NexusAgentsDocument {
	return { ...document, alwaysCreatePullRequests: enabled };
}

export function startLocalConversation(document: NexusAgentsDocument, folder: string, id: string, threadId: string, title?: string): NexusAgentsDocument {
	const conversation: NexusFolderConversation = {
		id,
		origin: 'agents',
		folder,
		runtime: 'local',
		title: title ?? folderName(folder),
		messages: [],
		threadId,
		running: false,
		pendingApproval: false,
		queued: [],
		leftLocalChanges: false,
	};
	return {
		...document,
		conversations: [...document.conversations, conversation],
		selection: { kind: 'conversation', id },
	};
}

/** Selects the folder's existing local conversation, or starts one. Repeated calls do not add another. */
export function ensureLocalConversation(document: NexusAgentsDocument, folder: string, id: string, threadId: string): NexusAgentsDocument {
	const existing = document.conversations.find(conversation => conversation.origin === 'agents' && conversation.runtime === 'local' && conversation.folder === folder);
	if (existing) {
		return { ...document, selection: { kind: 'conversation', id: existing.id } };
	}
	return startLocalConversation(document, folder, id, threadId);
}

export function select(document: NexusAgentsDocument, selection: NexusSelection): NexusAgentsDocument {
	return { ...document, selection };
}

export function saveTranscript(document: NexusAgentsDocument, id: string, threadId: string, messages: readonly NexusTranscriptMessage[], running: boolean, pendingApproval: boolean): NexusAgentsDocument {
	return updateConversation(document, id, conversation => ({ ...conversation, threadId, messages, running, pendingApproval }));
}

/**
 * Copies a local chat into the document, including a follow-up that is waiting
 * and a steer. The chat widget is the view. This is the saved copy.
 */
export function syncConversation(document: NexusAgentsDocument, id: string, threadId: string, messages: readonly NexusTranscriptMessage[], running: boolean, pendingApproval: boolean, queued: readonly string[], steer: string | undefined): NexusAgentsDocument {
	return updateConversation(document, id, conversation => {
		const { steer: _previous, ...rest } = conversation;
		const next: NexusFolderConversation = { ...rest, threadId, messages, running, pendingApproval, queued };
		return steer === undefined ? next : { ...next, steer };
	});
}

/** `git diff` arguments that compare a branch with its base. They do not check the branch out. */
export function reviewDiffArguments(base: string, branch: string): readonly string[] {
	return ['diff', '--no-ext-diff', `${base}...${branch}`];
}

export interface IMoveConversationOptions {
	readonly githubRepository?: string;
	readonly defaultBranch?: string;
	/** A checkout of the repository is already on this machine. */
	readonly localCheckout?: boolean;
}

export function moveConversation(document: NexusAgentsDocument, id: string, target: 'local' | 'remote', options: IMoveConversationOptions = {}): NexusServiceResult<void> {
	const conversation = document.conversations.find(entry => entry.id === id);
	if (!conversation) {
		return { ok: false, error: 'That conversation is not in the Agents window.' };
	}
	if (conversation.running || conversation.pendingApproval) {
		return { ok: false, error: 'Wait for the current turn to finish before moving the conversation.' };
	}
	if (target === 'remote') {
		if (!options.githubRepository) {
			return { ok: false, error: 'The folder has to be a GitHub repository the service can clone.' };
		}
		const baseBranch = options.defaultBranch ?? 'main';
		return {
			ok: true,
			document: updateConversation(document, id, () => ({
				...conversation,
				runtime: 'remote',
				repository: options.githubRepository,
				baseBranch,
				branch: `nexus/${conversation.id}`,
				leftLocalChanges: true,
			})),
			value: undefined,
		};
	}
	if (!options.localCheckout) {
		return { ok: false, error: 'Clone the repository onto this machine before moving the conversation here.' };
	}
	return {
		ok: true,
		document: updateConversation(document, id, () => ({ ...conversation, runtime: 'local' })),
		value: undefined,
	};
}

export function followUp(document: NexusAgentsDocument, id: string, text: string, mode: 'queue' | 'steer'): NexusServiceResult<void> {
	const conversation = document.conversations.find(entry => entry.id === id);
	if (!conversation || text.trim().length === 0) {
		return { ok: false, error: 'Type a message first.' };
	}
	if (!conversation.running && !conversation.pendingApproval) {
		if (conversation.runtime === 'remote' && !document.reachable) {
			return { ok: true, document: { ...document, outbox: [...document.outbox, { conversationId: id, text }] }, value: undefined };
		}
		return { ok: true, document: appendMessage(document, id, text), value: undefined };
	}
	if (mode === 'steer') {
		return { ok: true, document: updateConversation(document, id, current => ({ ...current, steer: text })), value: undefined };
	}
	return { ok: true, document: updateConversation(document, id, current => ({ ...current, queued: [...current.queued, text] })), value: undefined };
}

/**
 * A tool is about to run. An approval prompt is part of the turn, so a steer
 * waits until the user has answered it. Queued messages stay queued until the
 * turn finishes.
 */
export function toolBoundary(document: NexusAgentsDocument, id: string): { readonly document: NexusAgentsDocument; readonly steer?: string } {
	const conversation = document.conversations.find(entry => entry.id === id);
	if (!conversation?.steer || conversation.pendingApproval) {
		return { document };
	}
	return {
		document: updateConversation(document, id, current => {
			const { steer: _steer, ...rest } = current;
			return { ...rest, messages: [...rest.messages, { role: 'user', text: conversation.steer! }] };
		}),
		steer: conversation.steer,
	};
}

/**
 * The turn ended. A steer that was still waiting (the approval prompt was part
 * of the turn) is delivered first, then queued messages, in order.
 */
export function finishTurn(document: NexusAgentsDocument, id: string): NexusAgentsDocument {
	return updateConversation(document, id, conversation => {
		const messages = [...conversation.messages];
		if (conversation.steer) {
			messages.push({ role: 'user', text: conversation.steer });
		}
		for (const text of conversation.queued) {
			messages.push({ role: 'user', text });
		}
		const { steer: _steer, ...rest } = conversation;
		return { ...rest, messages, running: false, pendingApproval: false, queued: [] };
	});
}

export function createProject(document: NexusAgentsDocument, id: string, name: string, repository: string, model: string): NexusServiceResult<void> {
	const gate = requireSignedInService(document);
	if (gate) {
		return gate;
	}
	if (!document.githubConnected) {
		return { ok: false, error: 'Connect GitHub to this NexusIDE account first.' };
	}
	if (!isGitHubRepository(repository)) {
		return { ok: false, error: 'A Project is bound to one GitHub repository.' };
	}
	if (model.trim().length === 0) {
		return { ok: false, error: 'Choose a model for the coordinator.' };
	}
	const project: NexusProject = { id, name: name.trim() || repository, repository, model, agents: [] };
	return {
		ok: true,
		document: { ...document, projects: [...document.projects, project], selection: { kind: 'project', id } },
		value: undefined,
	};
}

/** The coordinator does not write code. It hands the work to a remote agent on a new branch. */
export function messageProject(document: NexusAgentsDocument, projectId: string, agentId: string, prompt: string, defaultBranch = 'main'): NexusServiceResult<NexusProjectAgent> {
	const gate = requireSignedInService(document);
	if (gate) {
		return gate;
	}
	const project = document.projects.find(entry => entry.id === projectId);
	if (!project) {
		return { ok: false, error: 'That Project is not in the Agents window.' };
	}
	if (prompt.trim().length === 0) {
		return { ok: false, error: 'Type a message first.' };
	}
	const agent: NexusProjectAgent = {
		id: agentId,
		baseBranch: defaultBranch,
		branch: `nexus/${agentId}`,
		prompt: prompt.trim(),
		status: 'running',
	};
	const projects = document.projects.map(entry => entry.id === projectId ? { ...entry, agents: [...entry.agents, agent] } : entry);
	return {
		ok: true,
		document: { ...document, projects, selection: { kind: 'agent', projectId, agentId } },
		value: agent,
	};
}

export function finishProjectAgent(document: NexusAgentsDocument, projectId: string, agentId: string): NexusServiceResult<void> {
	const project = document.projects.find(entry => entry.id === projectId);
	const agent = project?.agents.find(entry => entry.id === agentId);
	if (!project || !agent) {
		return { ok: false, error: 'That agent is not under the Project.' };
	}
	const opened = openPullRequest(document, project.repository, agent.baseBranch, agent.branch);
	const projects = document.projects.map(entry => entry.id !== projectId ? entry : {
		...entry,
		agents: entry.agents.map(current => current.id === agentId ? { ...current, status: 'finished' as const, pullRequestUrl: opened.url } : current),
	});
	return { ok: true, document: { ...opened.document, projects }, value: undefined };
}

export interface ICreateAutomationOptions {
	readonly id: string;
	readonly name: string;
	readonly prompt: string;
	readonly model: string;
	readonly triggers: readonly NexusTrigger[];
	readonly repositories: readonly string[];
	readonly commentOnPullRequest?: boolean;
	readonly sendToSlack?: boolean;
	readonly mcp?: readonly NexusMcpServer[];
	readonly webhookKey: string;
}

export function createAutomation(document: NexusAgentsDocument, options: ICreateAutomationOptions): NexusServiceResult<NexusAutomation> {
	const gate = requireSignedInService(document);
	if (gate) {
		return gate;
	}
	if (options.model.trim().length === 0) {
		return { ok: false, error: 'Choose a model for the Automation.' };
	}
	if (options.triggers.length === 0) {
		return { ok: false, error: 'Choose a trigger.' };
	}
	if (options.triggers.some(trigger => trigger.kind === 'github') && options.repositories.length === 0) {
		return { ok: false, error: 'A GitHub event needs at least one repository.' };
	}
	if (options.triggers.some(trigger => trigger.kind === 'slack') && !document.slackConnected) {
		return { ok: false, error: 'Connect the NexusIDE Slack app first.' };
	}
	for (const repository of options.repositories) {
		if (!isGitHubRepository(repository)) {
			return { ok: false, error: 'An Automation repository is a GitHub repository.' };
		}
	}
	const wantsWebhook = options.triggers.some(trigger => trigger.kind === 'webhook');
	const automation: NexusAutomation = {
		id: options.id,
		name: options.name.trim() || 'Automation',
		prompt: options.prompt,
		model: options.model,
		triggers: options.triggers,
		repositories: options.repositories,
		commentOnPullRequest: options.commentOnPullRequest ?? true,
		sendToSlack: options.sendToSlack ?? true,
		mcp: options.mcp ?? [],
		...(wantsWebhook ? { webhook: { url: `https://hooks.nexuside.local/${options.id}`, key: options.webhookKey } } : {}),
		active: true,
		runs: [],
	};
	return {
		ok: true,
		document: { ...document, automations: [...document.automations, automation], selection: { kind: 'automation', id: options.id } },
		value: automation,
	};
}

export type NexusIncomingEvent =
	| { readonly source: 'github'; readonly event: GitHubTriggerName; readonly repository: string; readonly fromFork: boolean }
	| { readonly source: 'slack'; readonly event: SlackTriggerName; readonly publicChannel: boolean; readonly threaded?: boolean }
	| { readonly source: 'schedule'; readonly cron: string }
	| { readonly source: 'webhook'; readonly automationId: string };

/** Fork pull requests do not start a run, except when a pull request is merged. Slack is public channels only. */
export function automationMatches(automation: NexusAutomation, event: NexusIncomingEvent): boolean {
	if (!automation.active) {
		return false;
	}
	if (event.source === 'webhook') {
		return event.automationId === automation.id && automation.triggers.some(trigger => trigger.kind === 'webhook');
	}
	if (event.source === 'schedule') {
		return automation.triggers.some(trigger => trigger.kind === 'schedule' && trigger.cron === event.cron);
	}
	if (event.source === 'slack') {
		if (!event.publicChannel) {
			return false;
		}
		if (event.event === 'message' && event.threaded) {
			return false;
		}
		return automation.triggers.some(trigger => trigger.kind === 'slack' && trigger.event === event.event);
	}
	if (event.fromFork && event.event !== 'pull_request_merged') {
		return false;
	}
	if (!automation.repositories.includes(event.repository)) {
		return false;
	}
	return automation.triggers.some(trigger => trigger.kind === 'github' && trigger.event === event.event);
}

export function finishAutomationRun(document: NexusAgentsDocument, automationId: string, runId: string, defaultBranch = 'main'): NexusServiceResult<void> {
	const automation = document.automations.find(entry => entry.id === automationId);
	if (!automation) {
		return { ok: false, error: 'That Automation is not in the Agents window.' };
	}
	const repository = automation.repositories[0];
	let opened = { document, url: undefined as string | undefined };
	let branch: string | undefined;
	let baseBranch: string | undefined;
	if (repository && document.alwaysCreatePullRequests) {
		baseBranch = defaultBranch;
		branch = `nexus/${runId}`;
		const pull = openPullRequest(document, repository, baseBranch, branch);
		opened = { document: pull.document, url: pull.url };
	}
	const run: NexusAutomationRun = {
		id: runId,
		...(repository ? { repository, branch, baseBranch } : {}),
		...(opened.url ? { pullRequestUrl: opened.url } : {}),
	};
	const automations = opened.document.automations.map(entry => entry.id === automationId ? { ...entry, runs: [...entry.runs, run] } : entry);
	return { ok: true, document: { ...opened.document, automations }, value: undefined };
}

export type NexusIdeTarget =
	| { readonly kind: 'none' }
	| { readonly kind: 'clone'; readonly repository: string }
	| { readonly kind: 'open'; readonly folder: string; readonly review?: { readonly base: string; readonly branch: string; readonly checkout: false } };

export function resolveIdeTarget(document: NexusAgentsDocument): NexusIdeTarget {
	const selection = document.selection;
	if (selection.kind === 'none') {
		return { kind: 'none' };
	}
	if (selection.kind === 'conversation') {
		const conversation = document.conversations.find(entry => entry.id === selection.id);
		if (!conversation) {
			return { kind: 'none' };
		}
		return conversationTarget(document, conversation);
	}
	if (selection.kind === 'project') {
		const project = document.projects.find(entry => entry.id === selection.id);
		return project ? repositoryTarget(document, project.repository) : { kind: 'none' };
	}
	if (selection.kind === 'agent') {
		const project = document.projects.find(entry => entry.id === selection.projectId);
		const agent = project?.agents.find(entry => entry.id === selection.agentId);
		if (!project || !agent) {
			return { kind: 'none' };
		}
		const opened = repositoryTarget(document, project.repository);
		if (opened.kind !== 'open') {
			return opened;
		}
		return { kind: 'open', folder: opened.folder, review: { base: agent.baseBranch, branch: agent.branch, checkout: false } };
	}
	const automation = document.automations.find(entry => entry.id === selection.id);
	if (!automation || automation.repositories.length === 0) {
		return { kind: 'none' };
	}
	return repositoryTarget(document, automation.repositories[0]);
}

export function rememberClone(document: NexusAgentsDocument, repository: string, parent: URI): NexusAgentsDocument {
	const folder = URI.joinPath(parent, repositoryName(repository));
	return {
		...document,
		cloneParents: { ...document.cloneParents, [repository]: parent.toString() },
		clones: { ...document.clones, [repository]: folder.toString() },
	};
}

export function cloneParent(document: NexusAgentsDocument, repository: string): URI | undefined {
	const parent = document.cloneParents[repository];
	return parent ? URI.parse(parent) : undefined;
}

export function setPendingReview(document: NexusAgentsDocument, review: { readonly folder: string; readonly base: string; readonly branch: string }): NexusAgentsDocument {
	return { ...document, pendingReview: review };
}

/** The code window shows the diff once, and the local checkout is not changed. */
export function consumePendingReview(document: NexusAgentsDocument, folder: string): { readonly document: NexusAgentsDocument; readonly review?: { readonly base: string; readonly branch: string; readonly checkout: false } } {
	if (document.pendingReview?.folder !== folder) {
		return { document };
	}
	const { pendingReview, ...rest } = document;
	return { document: rest, review: { base: pendingReview.base, branch: pendingReview.branch, checkout: false } };
}

export function parseNexusAgentsDocument(serialized: string): NexusAgentsDocument {
	if (!serialized) {
		return emptyNexusAgentsDocument();
	}
	let value: unknown;
	try {
		value = JSON.parse(serialized);
	} catch {
		return emptyNexusAgentsDocument();
	}
	if (!value || typeof value !== 'object') {
		return emptyNexusAgentsDocument();
	}
	const record = value as Partial<NexusAgentsDocument>;
	const empty = emptyNexusAgentsDocument();
	return {
		...empty,
		reachable: record.reachable !== false,
		signedIn: record.signedIn === true,
		alwaysCreatePullRequests: record.alwaysCreatePullRequests !== false,
		githubConnected: record.githubConnected === true,
		slackConnected: record.slackConnected === true,
		nextPullRequest: typeof record.nextPullRequest === 'number' ? record.nextPullRequest : 1,
		outbox: Array.isArray(record.outbox) ? record.outbox.filter(isOutboxEntry) : [],
		conversations: Array.isArray(record.conversations) ? record.conversations.filter(isAgentsConversation) : [],
		projects: Array.isArray(record.projects) ? record.projects.filter(isProject) : [],
		automations: Array.isArray(record.automations) ? record.automations.filter(isAutomation) : [],
		selection: isSelection(record.selection) ? record.selection : { kind: 'none' },
		cloneParents: isStringRecord(record.cloneParents) ? record.cloneParents : {},
		clones: isStringRecord(record.clones) ? record.clones : {},
		...(record.pendingReview && isPendingReview(record.pendingReview) ? { pendingReview: record.pendingReview } : {}),
	};
}

export function isGitHubRepository(repository: string): boolean {
	return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository);
}

function conversationTarget(document: NexusAgentsDocument, conversation: NexusFolderConversation): NexusIdeTarget {
	if (conversation.runtime === 'local' && conversation.folder) {
		return { kind: 'open', folder: conversation.folder };
	}
	if (conversation.repository) {
		const opened = repositoryTarget(document, conversation.repository);
		if (opened.kind === 'open' && conversation.branch && conversation.baseBranch) {
			return { kind: 'open', folder: opened.folder, review: { base: conversation.baseBranch, branch: conversation.branch, checkout: false } };
		}
		if (opened.kind === 'open' && conversation.folder) {
			return { kind: 'open', folder: conversation.folder };
		}
		return opened;
	}
	return conversation.folder ? { kind: 'open', folder: conversation.folder } : { kind: 'none' };
}

function repositoryTarget(document: NexusAgentsDocument, repository: string): NexusIdeTarget {
	const folder = document.clones[repository];
	return folder ? { kind: 'open', folder } : { kind: 'clone', repository };
}

function openPullRequest(document: NexusAgentsDocument, repository: string, base: string, branch: string): { readonly document: NexusAgentsDocument; readonly url?: string } {
	if (!document.alwaysCreatePullRequests) {
		return { document };
	}
	const url = `https://github.com/${repository}/pull/${document.nextPullRequest}`;
	return { document: { ...document, nextPullRequest: document.nextPullRequest + 1 }, url: `${url}?base=${encodeURIComponent(base)}&head=${encodeURIComponent(branch)}` };
}

function requireSignedInService(document: NexusAgentsDocument): NexusServiceError | undefined {
	if (!document.reachable) {
		return { ok: false, error: SERVICE_UNREACHABLE };
	}
	if (!document.signedIn) {
		return { ok: false, error: 'Sign in to a NexusIDE account first.' };
	}
	return undefined;
}

function flushOutbox(document: NexusAgentsDocument): NexusAgentsDocument {
	let next = document;
	for (const entry of document.outbox) {
		next = appendMessage(next, entry.conversationId, entry.text);
	}
	return { ...next, outbox: [] };
}

function appendMessage(document: NexusAgentsDocument, id: string, text: string): NexusAgentsDocument {
	return updateConversation(document, id, conversation => ({
		...conversation,
		messages: [...conversation.messages, { role: 'user', text }],
	}));
}

function updateConversation(document: NexusAgentsDocument, id: string, update: (conversation: NexusFolderConversation) => NexusFolderConversation): NexusAgentsDocument {
	return {
		...document,
		conversations: document.conversations.map(conversation => conversation.id === id ? update(conversation) : conversation),
	};
}

function folderName(folder: string): string {
	try {
		const uri = URI.parse(folder);
		const parts = uri.path.split('/').filter(part => part.length > 0);
		return parts[parts.length - 1] ?? folder;
	} catch {
		return folder;
	}
}

function repositoryName(repository: string): string {
	return repository.slice(repository.lastIndexOf('/') + 1);
}

function isAgentsConversation(value: unknown): value is NexusFolderConversation {
	const conversation = value as Partial<NexusFolderConversation> | undefined;
	return !!conversation && conversation.origin === 'agents' && (conversation.runtime === 'local' || conversation.runtime === 'remote') && typeof conversation.id === 'string';
}

function isProject(value: unknown): value is NexusProject {
	const project = value as Partial<NexusProject> | undefined;
	return !!project && typeof project.id === 'string' && typeof project.repository === 'string' && Array.isArray(project.agents);
}

function isAutomation(value: unknown): value is NexusAutomation {
	const automation = value as Partial<NexusAutomation> | undefined;
	return !!automation && typeof automation.id === 'string' && Array.isArray(automation.triggers);
}

function isOutboxEntry(value: unknown): value is NexusOutboxEntry {
	const entry = value as Partial<NexusOutboxEntry> | undefined;
	return !!entry && typeof entry.conversationId === 'string' && typeof entry.text === 'string';
}

function isSelection(value: unknown): value is NexusSelection {
	const selection = value as Partial<NexusSelection> | undefined;
	if (!selection || typeof selection.kind !== 'string') {
		return false;
	}
	return selection.kind === 'none' || selection.kind === 'conversation' || selection.kind === 'project' || selection.kind === 'agent' || selection.kind === 'automation';
}

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isPendingReview(value: unknown): value is { readonly folder: string; readonly base: string; readonly branch: string } {
	const review = value as { folder?: unknown; base?: unknown; branch?: unknown };
	return typeof review.folder === 'string' && typeof review.base === 'string' && typeof review.branch === 'string';
}
