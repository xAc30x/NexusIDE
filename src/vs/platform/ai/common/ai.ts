/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NexusIDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

/**
 * Result wrapper returned by every {@link IAIService} method.
 *
 * Expected failures (unknown provider, a thread that already has an active run,
 * an unknown stream id, ...) are reported as `{ ok: false, error }` instead of a
 * rejected promise. A rejected promise therefore means the IPC transport or the
 * service itself failed unexpectedly.
 */
export type AIResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly error: string };

/**
 * Execution modes offered by the chat panel. The mode travels with each request
 * so the main process can decide which capabilities the backend may use.
 *
 * - `ask`: read-only questions about the codebase.
 * - `plan`: produces a markdown task list and proposed file changes.
 * - `agent`: may read and write files and run terminal commands.
 * - `debug`: analyses stack traces, test logs and failing code paths.
 */
export const AI_EXECUTION_MODES = ['ask', 'plan', 'agent', 'debug'] as const;
export type AIExecutionMode = typeof AI_EXECUTION_MODES[number];

/**
 * How a provider is reached from the main process.
 */
export type AIProviderKind = 'cli' | 'http';

export interface IAIProviderInfo {
	/** Stable identifier, for example `claude-cli` or `anthropic`. */
	readonly id: string;
	readonly displayName: string;
	readonly kind: AIProviderKind;
	/**
	 * Whether the provider can accept requests right now, for example because
	 * the CLI binary was found or an API key is stored.
	 */
	readonly available: boolean;
}

export interface IAIMessageRequest {
	/** Chat thread the message belongs to. Only one run per thread may be active. */
	readonly threadId: string;
	readonly providerId: string;
	readonly mode: AIExecutionMode;
	readonly prompt: string;
	/** Provider-specific model name. The provider default is used when omitted. */
	readonly model?: string;
	/**
	 * Absolute file system path of the folder the provider works in, usually
	 * the workspace folder. Providers decide their own default when omitted.
	 */
	readonly workingDirectory?: string;
}

/**
 * Identifies the run started by {@link IAIService.sendMessage}.
 */
export interface IAIRunHandle {
	readonly threadId: string;
	readonly streamId: string;
}

/**
 * Why a stream ended.
 */
export type AIStreamEndReason = 'completed' | 'cancelled' | 'failed';

/**
 * One entry in a stream. Cursors start at 0 and increase by 1 for each chunk
 * of the same stream, so a reader that has seen cursor `n` resumes at `n + 1`.
 * The `end` chunk is always the last chunk of a stream.
 */
export type AIStreamChunk =
	| { readonly kind: 'text'; readonly cursor: number; readonly text: string }
	/** A tool the provider used. `failed` is true when it failed or was denied. */
	| { readonly kind: 'tool'; readonly cursor: number; readonly summary: string; readonly failed: boolean }
	| { readonly kind: 'permission'; readonly cursor: number; readonly requestId: string; readonly toolName: string; readonly summary: string; readonly detail?: string }
	| { readonly kind: 'permissionResolved'; readonly cursor: number; readonly requestId: string; readonly decision: AIPermissionDecision }
	| { readonly kind: 'end'; readonly cursor: number; readonly reason: AIStreamEndReason; readonly error?: string };

/**
 * Answer to a `permission` chunk. Requests that are still open when a run ends
 * or is cancelled are denied.
 */
export type AIPermissionDecision = 'allow' | 'deny';

/**
 * Payload of {@link IAIService.onDidStreamDelta}: chunks appended to a stream
 * since the previous event for that stream.
 */
export interface IAIStreamDelta {
	readonly streamId: string;
	readonly chunks: readonly AIStreamChunk[];
}

export interface IAIStreamReadResult {
	readonly streamId: string;
	/** Chunks with a cursor greater than or equal to the requested cursor. */
	readonly chunks: readonly AIStreamChunk[];
	/** Cursor to pass to the next {@link IAIService.readStream} call. */
	readonly nextCursor: number;
	/** True once the `end` chunk has been written. */
	readonly done: boolean;
	/**
	 * True when chunks before the first returned chunk were requested but are no
	 * longer buffered, so the reader missed part of the stream.
	 */
	readonly truncated: boolean;
}

export const IAIService = createDecorator<IAIService>('aiService');

/** Name of the IPC channel through which renderers reach {@link IAIService}. */
export const AI_CHANNEL_NAME = 'ai';

/**
 * Main-process AI service. Provider routing, process spawning and API key
 * handling stay in the main process; renderers use this interface over IPC.
 */
export interface IAIService {
	readonly _serviceBrand: undefined;

	/** Fires whenever chunks are appended to any stream. */
	readonly onDidStreamDelta: Event<IAIStreamDelta>;

	listProviders(): Promise<AIResult<readonly IAIProviderInfo[]>>;

	/**
	 * Starts a run for `request.threadId`. Fails with `ok: false` if that thread
	 * already has an active run.
	 */
	sendMessage(request: IAIMessageRequest): Promise<AIResult<IAIRunHandle>>;

	/**
	 * Returns buffered chunks of a stream starting at `fromCursor`. Used to replay
	 * a stream or recover chunks missed between events.
	 */
	readStream(streamId: string, fromCursor: number): Promise<AIResult<IAIStreamReadResult>>;

	/**
	 * Cancels the active run of a thread. The value is `true` if a run was
	 * cancelled and `false` if the thread had no active run.
	 */
	cancelRun(threadId: string): Promise<AIResult<boolean>>;

	/**
	 * Answers a `permission` chunk of the active run of a thread. The value is
	 * `true` if the request was open and is now answered, and `false` if it was
	 * already answered or its run has ended.
	 */
	respondToPermission(threadId: string, requestId: string, decision: AIPermissionDecision): Promise<AIResult<boolean>>;
}
