/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NexusIDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getErrorMessage } from '../../../../base/common/errors.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { AIExecutionMode, AIResult, AIStreamChunk, IAIProviderInfo, IAIService, IAIStreamDelta, IAIStreamReadResult } from '../../../../platform/ai/common/ai.js';

export type NexusChatRole = 'user' | 'assistant';

/**
 * - `streaming`: the reply is still arriving.
 * - `completed`, `cancelled`, `failed`: the reply has ended for that reason.
 */
export type NexusChatMessageState = 'streaming' | 'completed' | 'cancelled' | 'failed';

export interface INexusChatMessage {
	readonly id: string;
	readonly role: NexusChatRole;
	readonly text: string;
	readonly state: NexusChatMessageState;
	/** Why the reply failed. Set only when `state` is `failed`. */
	readonly error?: string;
	/** Set when part of the reply could not be recovered. */
	readonly warning?: string;
}

export interface INexusChatSendOptions {
	readonly mode: AIExecutionMode;
	readonly providerId: string;
	/** Absolute folder the provider works in, usually the first workspace folder. */
	readonly workingDirectory?: string;
}

export const LOST_TEXT_WARNING = 'Part of this reply was lost because it was too long to keep.';

interface IMutableMessage {
	readonly id: string;
	readonly role: NexusChatRole;
	text: string;
	state: NexusChatMessageState;
	error?: string;
	warning?: string;
}

/** Tracks the reply that is currently streaming. */
interface IActiveReply {
	readonly message: IMutableMessage;
	/** Known once `sendMessage` returns. Events for other streams are ignored. */
	streamId: string | undefined;
	/** Cursor of the next chunk this reply expects. */
	nextCursor: number;
	/** True while a `readStream` call is filling a gap. */
	catchingUp: boolean;
	/** True when another gap was seen during a catch-up. */
	catchUpAgain: boolean;
}

/**
 * The messages of one chat and the reply that is streaming into it.
 *
 * Replies arrive as `onDidStreamDelta` events. The model tracks the cursor of
 * the next expected chunk, so it skips chunks it has already applied and asks
 * `readStream` for chunks it missed, for example events that fired before
 * `sendMessage` returned the stream id.
 *
 * It holds no UI code so it can be unit tested without a workbench.
 */
export class NexusChatModel extends Disposable {

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private readonly _messages: IMutableMessage[] = [];
	private _threadId = generateUuid();
	private active: IActiveReply | undefined;

	constructor(
		@IAIService private readonly aiService: IAIService,
	) {
		super();
		this._register(this.aiService.onDidStreamDelta(delta => this.onStreamDelta(delta)));
	}

	get messages(): readonly INexusChatMessage[] {
		return this._messages;
	}

	get threadId(): string {
		return this._threadId;
	}

	get isRunning(): boolean {
		return this.active !== undefined;
	}

	/**
	 * Adds the prompt and an empty reply, then starts the run. Fails without
	 * changing the chat if the prompt is empty or a reply is still running.
	 * If the service refuses the request, the reply is marked as failed.
	 */
	async send(prompt: string, options: INexusChatSendOptions): Promise<AIResult<void>> {
		if (prompt.trim().length === 0) {
			return { ok: false, error: 'Type a message first.' };
		}
		if (this.active) {
			return { ok: false, error: 'Wait for the current reply to finish, or stop it.' };
		}

		this._messages.push({ id: generateUuid(), role: 'user', text: prompt, state: 'completed' });
		const reply: IMutableMessage = { id: generateUuid(), role: 'assistant', text: '', state: 'streaming' };
		this._messages.push(reply);
		const active: IActiveReply = { message: reply, streamId: undefined, nextCursor: 0, catchingUp: false, catchUpAgain: false };
		this.active = active;
		this._onDidChange.fire();

		let result: AIResult<{ readonly streamId: string }>;
		try {
			result = await this.aiService.sendMessage({
				threadId: this._threadId,
				providerId: options.providerId,
				mode: options.mode,
				prompt,
				workingDirectory: options.workingDirectory,
			});
		} catch (error) {
			result = { ok: false, error: getErrorMessage(error) || 'The AI service could not be reached.' };
		}

		if (this.active !== active) {
			// The chat was cleared or disposed while the request was sent.
			return { ok: true, value: undefined };
		}
		if (!result.ok) {
			this.finish(active, 'failed', result.error);
			return { ok: true, value: undefined };
		}

		active.streamId = result.value.streamId;
		// Events for this stream may have fired before its id was known.
		await this.catchUp(active);
		return { ok: true, value: undefined };
	}

	/** Asks the service to stop the running reply. The reply ends as `cancelled` once the stream reports it. */
	async stop(): Promise<AIResult<boolean>> {
		if (!this.active) {
			return { ok: true, value: false };
		}
		try {
			return await this.aiService.cancelRun(this._threadId);
		} catch (error) {
			return { ok: false, error: getErrorMessage(error) || 'The AI service could not be reached.' };
		}
	}

	/** Starts a new chat. A running reply is cancelled and its remaining output ignored. */
	clear(): void {
		this.abandonActiveReply();
		this._messages.length = 0;
		this._threadId = generateUuid();
		this._onDidChange.fire();
	}

	override dispose(): void {
		this.abandonActiveReply();
		super.dispose();
	}

	private abandonActiveReply(): void {
		if (!this.active) {
			return;
		}
		this.active = undefined;
		const threadId = this._threadId;
		// Best effort: the chat no longer shows this reply, so a failure only
		// means the provider finishes in the background.
		this.aiService.cancelRun(threadId).catch(() => { });
	}

	private onStreamDelta(delta: IAIStreamDelta): void {
		const active = this.active;
		if (!active || active.streamId === undefined || delta.streamId !== active.streamId) {
			return;
		}
		const gap = this.applyChunks(active, delta.chunks);
		if (gap) {
			void this.catchUp(active);
		}
	}

	/**
	 * Applies chunks in cursor order. Chunks already applied are skipped.
	 * Returns `true` when a chunk is missing, so the caller must catch up.
	 */
	private applyChunks(active: IActiveReply, chunks: readonly AIStreamChunk[]): boolean {
		let changed = false;
		let gap = false;
		for (const chunk of chunks) {
			if (this.active !== active) {
				break;
			}
			if (chunk.cursor < active.nextCursor) {
				continue;
			}
			if (chunk.cursor > active.nextCursor) {
				gap = true;
				break;
			}
			active.nextCursor++;
			changed = true;
			if (chunk.kind === 'text') {
				active.message.text += chunk.text;
			} else {
				this.finish(active, chunk.reason, chunk.error);
				return false;
			}
		}
		if (changed) {
			this._onDidChange.fire();
		}
		return gap;
	}

	/** Reads every chunk from the next expected cursor. Only one read runs at a time. */
	private async catchUp(active: IActiveReply): Promise<void> {
		if (active.catchingUp) {
			active.catchUpAgain = true;
			return;
		}
		active.catchingUp = true;
		try {
			do {
				active.catchUpAgain = false;
				if (this.active !== active || active.streamId === undefined) {
					return;
				}
				let result: AIResult<IAIStreamReadResult>;
				try {
					result = await this.aiService.readStream(active.streamId, active.nextCursor);
				} catch (error) {
					result = { ok: false, error: getErrorMessage(error) || 'The AI service could not be reached.' };
				}
				if (this.active !== active) {
					return;
				}
				if (!result.ok) {
					this.finish(active, 'failed', `Could not read the reply: ${result.error}`);
					return;
				}
				const { chunks, truncated } = result.value;
				if (truncated && chunks.length > 0) {
					// The oldest chunks were dropped from the buffer. Continue from what is left.
					active.message.warning = LOST_TEXT_WARNING;
					active.nextCursor = chunks[0].cursor;
				}
				if (this.applyChunks(active, chunks)) {
					// A read starts at the expected cursor, so a gap here means the
					// service skipped chunks. Reading again would return the same gap.
					this.finish(active, 'failed', 'The reply stream is missing a part of the reply.');
					return;
				}
				// Loops when an event reported a gap while this read was running.
			} while (active.catchUpAgain);
		} finally {
			active.catchingUp = false;
		}
	}

	private finish(active: IActiveReply, state: Exclude<NexusChatMessageState, 'streaming'>, error: string | undefined): void {
		active.message.state = state;
		if (state === 'failed') {
			active.message.error = error || 'The reply failed for an unknown reason.';
		}
		if (this.active === active) {
			this.active = undefined;
		}
		this._onDidChange.fire();
	}
}

/**
 * Chooses the provider for the next message: the preferred one if it is
 * available, otherwise the first available one, in the order the service
 * lists them.
 */
export function pickProvider(providers: readonly IAIProviderInfo[], preferredId: string | undefined): IAIProviderInfo | undefined {
	const available = providers.filter(provider => provider.available);
	return available.find(provider => provider.id === preferredId) ?? available[0];
}
