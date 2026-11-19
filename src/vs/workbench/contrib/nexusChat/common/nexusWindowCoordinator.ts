/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NexusIDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DeferredPromise, raceTimeout, timeout } from '../../../../base/common/async.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';

/**
 * Messages NexusIDE windows send each other to find the one Agents window, the
 * most recently used code window for a folder, and to hand a new window the
 * role of Agents window. Windows ask each other live instead of keeping a list
 * in storage, so a window that crashed is never found.
 */
export type NexusWindowMessage =
	| { readonly kind: 'findAgents'; readonly requestId: string }
	| { readonly kind: 'agentsFound'; readonly requestId: string; readonly windowId: number }
	| { readonly kind: 'claimHandoff'; readonly requestId: string }
	| { readonly kind: 'handoff'; readonly requestId: string }
	| { readonly kind: 'findCode'; readonly requestId: string; readonly folder: string }
	| { readonly kind: 'codeFound'; readonly requestId: string; readonly windowId: number; readonly focusedAt: number }
	| { readonly kind: 'review'; readonly windowId: number; readonly folder: string; readonly base: string; readonly branch: string };

/** A channel that delivers each message to the other windows, but not back to the sender. */
export interface INexusWindowChannel {
	readonly onDidReceiveData: Event<NexusWindowMessage>;
	postData(message: NexusWindowMessage): void;
}

export interface INexusWindowCoordinatorHost {
	/** The id of this window, which other windows use to focus it. */
	readonly windowId: number;
	/** This window is the one Agents window. */
	isAgentsWindow(): boolean;
	/** The folder this code window has open, when it is a code window. */
	codeFolder(): string | undefined;
	/** When this code window was last used. The newest one is brought forward. */
	focusedAt(): number;
	/** Called when another window found this one, before it is brought to the front. */
	revealAgents?(): void;
	/**
	 * Shows a diff of `branch` against `base` in this code window.
	 * The checkout is left as it is.
	 */
	showReview?(folder: string, base: string, branch: string): void;
}

/**
 * How long a window waits for the others to answer before it decides nobody
 * will. Clicking Agent waits this long before it opens a new window, so it is
 * kept short; windows answer within a few milliseconds when they are idle.
 */
export const NEXUS_WINDOW_ANSWER_TIMEOUT_MS = 200;
/** How long a requested Agents window has to start and claim its role. */
export const NEXUS_HANDOFF_EXPIRY_MS = 60_000;

/**
 * Coordinates the code windows and the one Agents window of NexusIDE over a
 * channel that every window joins.
 */
export class NexusWindowCoordinator extends Disposable {

	/** When the Agents window this window asked for stops being claimed. */
	private pendingHandoffExpires: number | undefined;

	constructor(
		private readonly channel: INexusWindowChannel,
		private readonly host: INexusWindowCoordinatorHost,
		private readonly now: () => number = Date.now,
	) {
		super();
		this._register(channel.onDidReceiveData(message => this.answer(message)));
	}

	/** The id of the Agents window, or `undefined` when no window answers in time. */
	async findAgentsWindow(): Promise<number | undefined> {
		const requestId = generateUuid();
		return this.ask({ kind: 'findAgents', requestId }, message =>
			message.kind === 'agentsFound' && message.requestId === requestId ? message.windowId : undefined);
	}

	/** Whether this window asked for an Agents window that has not started yet. */
	hasPendingHandoff(): boolean {
		return this.pendingHandoffExpires !== undefined && this.pendingHandoffExpires > this.now();
	}

	/** Remembers that the next new window that claims the role is the Agents window. */
	offerHandoff(): void {
		this.pendingHandoffExpires = this.now() + NEXUS_HANDOFF_EXPIRY_MS;
	}

	/**
	 * Asks the other windows whether one of them opened this window to be the
	 * Agents window. Returns `true` when one of them did.
	 */
	async claimHandoff(): Promise<boolean> {
		const requestId = generateUuid();
		const claimed = await this.ask({ kind: 'claimHandoff', requestId }, message =>
			message.kind === 'handoff' && message.requestId === requestId ? true : undefined);
		return claimed === true;
	}

	/**
	 * The code window that most recently used `folder`, or `undefined` when
	 * none answers. Every answer in the wait is considered, so a busier window
	 * is not hidden by a faster one.
	 */
	async findCodeWindow(folder: string): Promise<number | undefined> {
		const requestId = generateUuid();
		const found: { windowId: number; focusedAt: number }[] = [];
		const listener = this.channel.onDidReceiveData(message => {
			if (message.kind === 'codeFound' && message.requestId === requestId) {
				found.push({ windowId: message.windowId, focusedAt: message.focusedAt });
			}
		});
		try {
			this.channel.postData({ kind: 'findCode', requestId, folder });
			await timeout(NEXUS_WINDOW_ANSWER_TIMEOUT_MS);
		} finally {
			listener.dispose();
		}
		found.sort((left, right) => right.focusedAt - left.focusedAt);
		return found[0]?.windowId;
	}

	/** Asks `windowId` to show the diff. The checkout is not changed. */
	requestReview(windowId: number, folder: string, base: string, branch: string): void {
		this.channel.postData({ kind: 'review', windowId, folder, base, branch });
	}

	private async ask<T>(request: NexusWindowMessage, match: (message: NexusWindowMessage) => T | undefined): Promise<T | undefined> {
		const answer = new DeferredPromise<T>();
		const listener = this.channel.onDidReceiveData(message => {
			const value = match(message);
			if (value !== undefined) {
				void answer.complete(value);
			}
		});
		try {
			this.channel.postData(request);
			return await raceTimeout(answer.p, NEXUS_WINDOW_ANSWER_TIMEOUT_MS);
		} finally {
			listener.dispose();
		}
	}

	private answer(message: NexusWindowMessage): void {
		switch (message.kind) {
			case 'findAgents':
				if (this.host.isAgentsWindow()) {
					this.host.revealAgents?.();
					this.channel.postData({ kind: 'agentsFound', requestId: message.requestId, windowId: this.host.windowId });
				}
				break;
			case 'claimHandoff':
				if (this.pendingHandoffExpires !== undefined && this.pendingHandoffExpires > this.now()) {
					// Only one window gets the role.
					this.pendingHandoffExpires = undefined;
					this.channel.postData({ kind: 'handoff', requestId: message.requestId });
				}
				break;
			case 'findCode':
				if (!this.host.isAgentsWindow() && this.host.codeFolder() === message.folder) {
					this.channel.postData({ kind: 'codeFound', requestId: message.requestId, windowId: this.host.windowId, focusedAt: this.host.focusedAt() });
				}
				break;
			case 'review':
				if (message.windowId === this.host.windowId) {
					this.host.showReview?.(message.folder, message.base, message.branch);
				}
				break;
		}
	}
}
