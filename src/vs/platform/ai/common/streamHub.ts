/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NexusIDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { AIResult, AIStreamChunk, AIStreamEndReason, IAIStreamDelta, IAIStreamReadResult } from './ai.js';

/**
 * Number of most recent chunks kept per stream. Older chunks are dropped and
 * reported to readers through `truncated: true`.
 */
export const DEFAULT_MAX_CHUNKS_PER_STREAM = 10_000;

/**
 * Number of ended streams kept for replay. When more streams end, the oldest
 * ended stream is removed.
 */
export const DEFAULT_MAX_ENDED_STREAMS = 50;

/**
 * A chunk other than `end`, before the hub assigns its cursor.
 */
export type AIStreamEvent = WithoutCursor<Exclude<AIStreamChunk, { readonly kind: 'end' }>>;

/** Removes `cursor` from each member of a union separately. */
type WithoutCursor<T> = T extends unknown ? Omit<T, 'cursor'> : never;

export interface IStreamHubOptions {
	readonly maxChunksPerStream: number;
	readonly maxEndedStreams: number;
}

interface IStreamState {
	/**
	 * Fixed-size circular buffer. The chunk with cursor `c` is stored at
	 * index `c % slots.length`.
	 */
	readonly slots: AIStreamChunk[];
	/** Cursor that the next appended chunk will receive. */
	nextCursor: number;
	ended: boolean;
}

/**
 * Holds the output of AI runs as append-only streams of numbered chunks.
 *
 * Writers append text and finally one `end` chunk. Readers either listen to
 * {@link onDidAppend} or call {@link read} with a cursor to replay a stream or
 * recover chunks they missed.
 */
export class StreamHub extends Disposable {

	private readonly _onDidAppend = this._register(new Emitter<IAIStreamDelta>());
	readonly onDidAppend: Event<IAIStreamDelta> = this._onDidAppend.event;

	private readonly streams = new Map<string, IStreamState>();
	/** Ids of ended streams that are still kept, oldest first. */
	private readonly endedStreamIds: string[] = [];
	private readonly options: IStreamHubOptions;

	constructor(options?: Partial<IStreamHubOptions>) {
		// Validate before super() so invalid options don't leave a half-built
		// disposable behind.
		const resolved = resolveOptions(options);
		super();
		this.options = resolved;
	}

	/**
	 * Creates an empty stream and returns its id.
	 */
	createStream(): string {
		const streamId = generateUuid();
		this.streams.set(streamId, {
			slots: new Array<AIStreamChunk>(this.options.maxChunksPerStream),
			nextCursor: 0,
			ended: false,
		});
		return streamId;
	}

	/**
	 * Appends a text chunk. The value is the cursor of the new chunk.
	 */
	appendText(streamId: string, text: string): AIResult<number> {
		if (text.length === 0) {
			return { ok: false, error: 'Text must not be empty.' };
		}
		return this.append(streamId, cursor => ({ kind: 'text', cursor, text }));
	}

	/**
	 * Appends a chunk of any kind except `end`, which only {@link end} writes.
	 * The value is the cursor of the new chunk.
	 */
	appendEvent(streamId: string, event: AIStreamEvent): AIResult<number> {
		if (event.kind === 'text') {
			return this.appendText(streamId, event.text);
		}
		return this.append(streamId, cursor => ({ ...event, cursor }));
	}

	/**
	 * Writes the final `end` chunk. No chunk can be appended afterwards. The
	 * value is the cursor of the `end` chunk.
	 */
	end(streamId: string, reason: AIStreamEndReason, error?: string): AIResult<number> {
		const result = this.append(streamId, cursor => error === undefined
			? { kind: 'end', cursor, reason }
			: { kind: 'end', cursor, reason, error });
		if (result.ok) {
			this.markEnded(streamId);
		}
		return result;
	}

	/**
	 * Returns the buffered chunks with a cursor greater than or equal to
	 * `fromCursor`.
	 */
	read(streamId: string, fromCursor: number): AIResult<IAIStreamReadResult> {
		if (!Number.isSafeInteger(fromCursor) || fromCursor < 0) {
			return { ok: false, error: `Invalid cursor: ${fromCursor}.` };
		}
		const stream = this.streams.get(streamId);
		if (!stream) {
			return { ok: false, error: `Unknown stream: ${streamId}.` };
		}
		if (fromCursor > stream.nextCursor) {
			return { ok: false, error: `Cursor ${fromCursor} is past the end of stream ${streamId} (next cursor ${stream.nextCursor}).` };
		}

		const firstBufferedCursor = Math.max(0, stream.nextCursor - stream.slots.length);
		const start = Math.max(fromCursor, firstBufferedCursor);
		const chunks: AIStreamChunk[] = [];
		for (let cursor = start; cursor < stream.nextCursor; cursor++) {
			chunks.push(stream.slots[cursor % stream.slots.length]);
		}

		return {
			ok: true,
			value: {
				streamId,
				chunks,
				nextCursor: stream.nextCursor,
				done: stream.ended,
				truncated: fromCursor < firstBufferedCursor,
			},
		};
	}

	private append(streamId: string, createChunk: (cursor: number) => AIStreamChunk): AIResult<number> {
		const stream = this.streams.get(streamId);
		if (!stream) {
			return { ok: false, error: `Unknown stream: ${streamId}.` };
		}
		if (stream.ended) {
			return { ok: false, error: `Stream ${streamId} has already ended.` };
		}

		const chunk = createChunk(stream.nextCursor);
		stream.slots[chunk.cursor % stream.slots.length] = chunk;
		stream.nextCursor++;
		this._onDidAppend.fire({ streamId, chunks: [chunk] });
		return { ok: true, value: chunk.cursor };
	}

	private markEnded(streamId: string): void {
		const stream = this.streams.get(streamId);
		if (!stream) {
			return;
		}
		stream.ended = true;
		this.endedStreamIds.push(streamId);
		while (this.endedStreamIds.length > this.options.maxEndedStreams) {
			const oldest = this.endedStreamIds.shift();
			if (oldest !== undefined) {
				this.streams.delete(oldest);
			}
		}
	}
}

function resolveOptions(options: Partial<IStreamHubOptions> | undefined): IStreamHubOptions {
	const resolved: IStreamHubOptions = {
		maxChunksPerStream: options?.maxChunksPerStream ?? DEFAULT_MAX_CHUNKS_PER_STREAM,
		maxEndedStreams: options?.maxEndedStreams ?? DEFAULT_MAX_ENDED_STREAMS,
	};
	assertPositiveInteger('maxChunksPerStream', resolved.maxChunksPerStream);
	assertPositiveInteger('maxEndedStreams', resolved.maxEndedStreams);
	return resolved;
}

function assertPositiveInteger(name: string, value: number): void {
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new Error(`${name} must be a positive integer, got ${value}.`);
	}
}
