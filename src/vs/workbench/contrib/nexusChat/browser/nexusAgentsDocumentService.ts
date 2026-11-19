/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NexusIDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { connectGitHub, connectSlack, consumePendingReview, createAutomation, createProject, ensureLocalConversation, finishAutomationRun, finishProjectAgent, finishTurn, followUp, type ICreateAutomationOptions, messageProject, moveConversation, type NexusAgentsDocument, type NexusIdeTarget, type NexusSelection, type NexusServiceResult, type NexusTranscriptMessage, NEXUS_AGENTS_STORAGE_KEY, parseNexusAgentsDocument, rememberClone, resolveIdeTarget, saveTranscript, select, setAlwaysCreatePullRequests, setPendingReview, setReachable, signIn, startLocalConversation, syncConversation, toolBoundary } from '../common/nexusAgentsDocument.js';

export const INexusAgentsDocumentService = createDecorator<INexusAgentsDocumentService>('nexusAgentsDocumentService');

/**
 * Reads and writes the Agents document in application storage.
 *
 * Every window shares the document. Remote commands go through the service
 * contract in `nexusAgentsDocument.ts`. This class does not run a model.
 */
export interface INexusAgentsDocumentService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Emitter<void>['event'];
	readonly snapshot: NexusAgentsDocument;
	setReachable(reachable: boolean): void;
	signIn(): NexusServiceResult<void>;
	connectGitHub(): NexusServiceResult<void>;
	connectSlack(): NexusServiceResult<void>;
	setAlwaysCreatePullRequests(enabled: boolean): void;
	startLocalConversation(folder: URI): string;
	ensureLocalConversation(folder: URI): string;
	select(selection: NexusSelection): void;
	saveTranscript(id: string, threadId: string, messages: readonly NexusTranscriptMessage[], running: boolean, pendingApproval: boolean): void;
	saveLocalSnapshot(id: string, threadId: string, messages: readonly NexusTranscriptMessage[], running: boolean, pendingApproval: boolean, queued: readonly string[], steer: string | undefined): void;
	moveConversation(id: string, target: 'local' | 'remote', githubRepository?: string, localCheckout?: boolean): NexusServiceResult<void>;
	followUp(id: string, text: string, mode: 'queue' | 'steer'): NexusServiceResult<void>;
	toolBoundary(id: string): string | undefined;
	finishTurn(id: string): void;
	createProject(name: string, repository: string, model: string): NexusServiceResult<string>;
	messageProject(projectId: string, prompt: string, defaultBranch?: string): NexusServiceResult<string>;
	finishProjectAgent(projectId: string, agentId: string): NexusServiceResult<void>;
	createAutomation(options: Omit<ICreateAutomationOptions, 'id' | 'webhookKey'>): NexusServiceResult<string>;
	finishAutomationRun(automationId: string): NexusServiceResult<void>;
	resolveIdeTarget(): NexusIdeTarget;
	rememberClone(repository: string, parent: URI): URI;
	setPendingReview(review: { readonly folder: string; readonly base: string; readonly branch: string }): void;
	consumePendingReview(folder: URI): { readonly base: string; readonly branch: string; readonly checkout: false } | undefined;
	openTerminal(folder: URI): Promise<void>;
	setTerminalOpener(opener: (folder: URI) => Promise<void>): void;
}

export class NexusAgentsDocumentService extends Disposable implements INexusAgentsDocumentService {

	declare readonly _serviceBrand: undefined;

	private document: NexusAgentsDocument;
	private terminalOpener: ((folder: URI) => Promise<void>) | undefined;
	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	constructor(@IStorageService private readonly storageService: IStorageService) {
		super();
		this.document = parseNexusAgentsDocument(this.storageService.get(NEXUS_AGENTS_STORAGE_KEY, StorageScope.APPLICATION, ''));
		// Another window writes the same application value. Ignore the echo of our own write.
		this._register(this.storageService.onDidChangeValue(StorageScope.APPLICATION, NEXUS_AGENTS_STORAGE_KEY, this._store)(() => {
			const serialized = this.storageService.get(NEXUS_AGENTS_STORAGE_KEY, StorageScope.APPLICATION, '');
			if (serialized === JSON.stringify(this.document)) {
				return;
			}
			this.document = parseNexusAgentsDocument(serialized);
			this._onDidChange.fire();
		}));
	}

	get snapshot(): NexusAgentsDocument {
		return this.document;
	}

	setReachable(reachable: boolean): void {
		this.commit(setReachable(this.document, reachable));
	}

	signIn(): NexusServiceResult<void> {
		return this.apply(signIn(this.document));
	}

	connectGitHub(): NexusServiceResult<void> {
		return this.apply(connectGitHub(this.document));
	}

	connectSlack(): NexusServiceResult<void> {
		return this.apply(connectSlack(this.document));
	}

	setAlwaysCreatePullRequests(enabled: boolean): void {
		this.commit(setAlwaysCreatePullRequests(this.document, enabled));
	}

	startLocalConversation(folder: URI): string {
		const id = generateUuid();
		this.commit(startLocalConversation(this.document, folder.toString(), id, generateUuid()));
		return id;
	}

	ensureLocalConversation(folder: URI): string {
		this.commit(ensureLocalConversation(this.document, folder.toString(), generateUuid(), generateUuid()));
		return this.document.selection.kind === 'conversation' ? this.document.selection.id : '';
	}

	select(selection: NexusSelection): void {
		this.commit(select(this.document, selection));
	}

	saveTranscript(id: string, threadId: string, messages: readonly NexusTranscriptMessage[], running: boolean, pendingApproval: boolean): void {
		this.commit(saveTranscript(this.document, id, threadId, messages, running, pendingApproval));
	}

	saveLocalSnapshot(id: string, threadId: string, messages: readonly NexusTranscriptMessage[], running: boolean, pendingApproval: boolean, queued: readonly string[], steer: string | undefined): void {
		this.commit(syncConversation(this.document, id, threadId, messages, running, pendingApproval, queued, steer));
	}

	moveConversation(id: string, target: 'local' | 'remote', githubRepository?: string, localCheckout?: boolean): NexusServiceResult<void> {
		return this.apply(moveConversation(this.document, id, target, { githubRepository, localCheckout }));
	}

	followUp(id: string, text: string, mode: 'queue' | 'steer'): NexusServiceResult<void> {
		return this.apply(followUp(this.document, id, text, mode));
	}

	toolBoundary(id: string): string | undefined {
		const result = toolBoundary(this.document, id);
		this.commit(result.document);
		return result.steer;
	}

	finishTurn(id: string): void {
		this.commit(finishTurn(this.document, id));
	}

	createProject(name: string, repository: string, model: string): NexusServiceResult<string> {
		const id = generateUuid();
		const result = createProject(this.document, id, name, repository, model);
		if (!result.ok) {
			return result;
		}
		this.commit(result.document);
		return { ok: true, document: this.document, value: id };
	}

	messageProject(projectId: string, prompt: string, defaultBranch?: string): NexusServiceResult<string> {
		const agentId = generateUuid();
		const result = messageProject(this.document, projectId, agentId, prompt, defaultBranch);
		if (!result.ok) {
			return result;
		}
		this.commit(result.document);
		return { ok: true, document: this.document, value: agentId };
	}

	finishProjectAgent(projectId: string, agentId: string): NexusServiceResult<void> {
		return this.apply(finishProjectAgent(this.document, projectId, agentId));
	}

	createAutomation(options: Omit<ICreateAutomationOptions, 'id' | 'webhookKey'>): NexusServiceResult<string> {
		const id = generateUuid();
		const result = createAutomation(this.document, { ...options, id, webhookKey: generateUuid() });
		if (!result.ok) {
			return result;
		}
		this.commit(result.document);
		return { ok: true, document: this.document, value: id };
	}

	finishAutomationRun(automationId: string): NexusServiceResult<void> {
		return this.apply(finishAutomationRun(this.document, automationId, generateUuid()));
	}

	resolveIdeTarget(): NexusIdeTarget {
		return resolveIdeTarget(this.document);
	}

	rememberClone(repository: string, parent: URI): URI {
		this.commit(rememberClone(this.document, repository, parent));
		return URI.parse(this.document.clones[repository]);
	}

	setPendingReview(review: { folder: string; base: string; branch: string }): void {
		this.commit(setPendingReview(this.document, review));
	}

	consumePendingReview(folder: URI): { base: string; branch: string; checkout: false } | undefined {
		const result = consumePendingReview(this.document, folder.toString());
		if (result.document !== this.document) {
			this.commit(result.document);
		}
		return result.review;
	}

	async openTerminal(folder: URI): Promise<void> {
		await this.terminalOpener?.(folder);
	}

	setTerminalOpener(opener: (folder: URI) => Promise<void>): void {
		this.terminalOpener = opener;
	}

	private apply<T>(result: NexusServiceResult<T>): NexusServiceResult<T> {
		if (result.ok) {
			this.commit(result.document);
		}
		return result;
	}

	private commit(document: NexusAgentsDocument): void {
		this.document = document;
		this.storageService.store(NEXUS_AGENTS_STORAGE_KEY, JSON.stringify(document), StorageScope.APPLICATION, StorageTarget.MACHINE);
		this._onDidChange.fire();
	}
}

registerSingleton(INexusAgentsDocumentService, NexusAgentsDocumentService, InstantiationType.Delayed);
