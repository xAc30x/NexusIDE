/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NexusIDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DeferredPromise, raceTimeout } from '../../../../base/common/async.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';

/**
 * Messages that NexusIDE windows send each other to find the Agents window of
 * a folder and to hand a new window the folder it should open the Agents chat
 * for. Windows ask each other live instead of keeping a list in storage, so a
 * window that crashed is never found.
 *
 * A folder is identified by its URI string, or by '' for no folder.
 */
export type NexusWindowMessage =
	| { readonly kind: 'findAgents'; readonly requestId: string; readonly folder: string }
	| { readonly kind: 'agentsFound'; readonly requestId: string; readonly windowId: number }
	| { readonly kind: 'claimHandoff'; readonly requestId: string }
	| { readonly kind: 'handoff'; readonly requestId: string; readonly folder: string };

/** A channel that delivers each message to the other windows, but not back to the sender. */
export interface INexusWindowChannel {
	readonly onDidReceiveData: Event<NexusWindowMessage>;
	postData(message: NexusWindowMessage): void;
}

export interface INexusWindowCoordinatorHost {
	/** The id of this window, which other windows use to focus it. */
	readonly windowId: number;
	/** The folders this window shows an Agents chat for. */
	agentsFolders(): readonly string[];
	/** Called when another window found this one as the Agents window of `folder`, before it is brought to the front. */
	revealAgents?(folder: string): void;
}

/**
 * How long a window waits for the others to answer before it decides nobody
 * will. Clicking Agent waits this long before it opens a new window, so it is
 * kept short; windows answer within a few milliseconds when they are idle.
 */
export const NEXUS_WINDOW_ANSWER_TIMEOUT_MS = 200;
/** How long a requested Agents window has to start and claim its folder. */
export const NEXUS_HANDOFF_EXPIRY_MS = 60_000;

/**
 * Coordinates the code windows and Agents windows of NexusIDE over a channel
 * that every window joins.
 */
export class NexusWindowCoordinator extends Disposable {

	/** The folder of an Agents window this window asked for that has not started yet. */
	private pendingHandoff: { readonly folder: string; readonly expires: number } | undefined;

	constructor(
		private readonly channel: INexusWindowChannel,
		private readonly host: INexusWindowCoordinatorHost,
		private readonly now: () => number = Date.now,
	) {
		super();
		this._register(channel.onDidReceiveData(message => this.answer(message)));
	}

	/** The id of a window that shows the Agents chat for `folder`, or `undefined` when no window answers in time. */
	async findAgentsWindow(folder: string): Promise<number | undefined> {
		const requestId = generateUuid();
		return this.ask({ kind: 'findAgents', requestId, folder }, message =>
			message.kind === 'agentsFound' && message.requestId === requestId ? message.windowId : undefined);
	}

	/** Whether this window asked for an Agents window for `folder` that has not started yet. */
	hasPendingHandoff(folder: string): boolean {
		return this.pendingHandoff !== undefined && this.pendingHandoff.folder === folder && this.pendingHandoff.expires > this.now();
	}

	/** Remembers that the next new window that claims a folder should get `folder`. */
	offerHandoff(folder: string): void {
		this.pendingHandoff = { folder, expires: this.now() + NEXUS_HANDOFF_EXPIRY_MS };
	}

	/**
	 * Asks the other windows whether one of them opened this window to show an
	 * Agents chat. Returns its folder, or `undefined` when no window did.
	 */
	async claimHandoff(): Promise<string | undefined> {
		const requestId = generateUuid();
		return this.ask({ kind: 'claimHandoff', requestId }, message =>
			message.kind === 'handoff' && message.requestId === requestId ? message.folder : undefined);
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
				if (this.host.agentsFolders().includes(message.folder)) {
					this.host.revealAgents?.(message.folder);
					this.channel.postData({ kind: 'agentsFound', requestId: message.requestId, windowId: this.host.windowId });
				}
				break;
			case 'claimHandoff': {
				const pending = this.pendingHandoff;
				if (pending && pending.expires > this.now()) {
					// Only one window gets the folder.
					this.pendingHandoff = undefined;
					this.channel.postData({ kind: 'handoff', requestId: message.requestId, folder: pending.folder });
				}
				break;
			}
		}
	}
}
