/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NexusIDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getErrorMessage, isCancellationError } from '../../../base/common/errors.js';
import { Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { ILogService } from '../../log/common/log.js';
import { AI_EXECUTION_MODES, AIExecutionMode, AIResult, IAIMessageRequest, IAIProviderInfo, IAIRunHandle, IAIService, IAIStreamDelta, IAIStreamReadResult } from './ai.js';
import { IAIProviderAdapter } from './aiProvider.js';
import { IReplyRun, ReplyRunner } from './replyRunner.js';
import { StreamHub } from './streamHub.js';

/**
 * Routes AI requests to provider adapters and exposes their replies as
 * replayable streams.
 *
 * It contains no Node.js or Electron code so it can be unit tested anywhere,
 * but it is only instantiated in the main process. Renderers reach it over
 * the `ai` IPC channel. Arguments are validated because they arrive over IPC.
 */
export class AIService extends Disposable implements IAIService {

	declare readonly _serviceBrand: undefined;

	private readonly streamHub = this._register(new StreamHub());
	private readonly replyRunner = this._register(new ReplyRunner());
	private readonly providers: ReadonlyMap<string, IAIProviderAdapter>;

	readonly onDidStreamDelta: Event<IAIStreamDelta> = this.streamHub.onDidAppend;

	constructor(
		providers: readonly IAIProviderAdapter[],
		@ILogService private readonly logService: ILogService,
	) {
		// Validate before super() so invalid input doesn't leave a half-built
		// disposable behind.
		const providersById = indexProviders(providers);
		super();
		this.providers = providersById;
	}

	async listProviders(): Promise<AIResult<readonly IAIProviderInfo[]>> {
		const infos = await Promise.all([...this.providers.values()].map(async provider => ({
			id: provider.id,
			displayName: provider.displayName,
			kind: provider.kind,
			available: await this.isProviderAvailable(provider),
		})));
		return { ok: true, value: infos };
	}

	async sendMessage(request: IAIMessageRequest): Promise<AIResult<IAIRunHandle>> {
		const invalid = validateRequest(request);
		if (invalid) {
			return { ok: false, error: invalid };
		}
		const provider = this.providers.get(request.providerId);
		if (!provider) {
			return { ok: false, error: `Unknown provider: ${request.providerId}.` };
		}
		if (!await this.isProviderAvailable(provider)) {
			return { ok: false, error: `Provider ${provider.displayName} is not available.` };
		}

		const started = this.replyRunner.tryStart(request.threadId);
		if (!started.ok) {
			return started;
		}

		const streamId = this.streamHub.createStream();
		// Runs in the background. It never rejects: every outcome ends the stream.
		void this.execute(provider, request, started.value, streamId);
		return { ok: true, value: { threadId: request.threadId, streamId } };
	}

	async readStream(streamId: string, fromCursor: number): Promise<AIResult<IAIStreamReadResult>> {
		if (!isNonEmptyString(streamId)) {
			return { ok: false, error: 'Stream id must be a non-empty string.' };
		}
		if (typeof fromCursor !== 'number') {
			return { ok: false, error: 'Cursor must be a number.' };
		}
		return this.streamHub.read(streamId, fromCursor);
	}

	async cancelRun(threadId: string): Promise<AIResult<boolean>> {
		if (!isNonEmptyString(threadId)) {
			return { ok: false, error: 'Thread id must be a non-empty string.' };
		}
		return { ok: true, value: this.replyRunner.cancel(threadId) };
	}

	private async execute(provider: IAIProviderAdapter, request: IAIMessageRequest, run: IReplyRun, streamId: string): Promise<void> {
		try {
			await provider.run(request, text => this.appendText(streamId, text), run.token);
			this.endStream(streamId, run.token.isCancellationRequested ? 'cancelled' : 'completed');
		} catch (error) {
			if (run.token.isCancellationRequested || isCancellationError(error)) {
				this.endStream(streamId, 'cancelled');
			} else {
				const message = getErrorMessage(error) || 'Unknown error.';
				this.logService.error(`[AI] Provider ${provider.id} failed for thread ${request.threadId}: ${message}`);
				this.endStream(streamId, 'failed', message);
			}
		} finally {
			run.finish();
		}
	}

	private appendText(streamId: string, text: string): void {
		if (typeof text !== 'string' || text.length === 0) {
			return;
		}
		const result = this.streamHub.appendText(streamId, text);
		if (!result.ok) {
			this.logService.warn(`[AI] Dropped text for stream ${streamId}: ${result.error}`);
		}
	}

	private endStream(streamId: string, reason: 'completed' | 'cancelled' | 'failed', error?: string): void {
		const result = this.streamHub.end(streamId, reason, error);
		if (!result.ok) {
			this.logService.warn(`[AI] Could not end stream ${streamId}: ${result.error}`);
		}
	}

	private async isProviderAvailable(provider: IAIProviderAdapter): Promise<boolean> {
		try {
			return await provider.isAvailable();
		} catch (error) {
			this.logService.warn(`[AI] Availability check of provider ${provider.id} failed: ${getErrorMessage(error)}`);
			return false;
		}
	}
}

function indexProviders(providers: readonly IAIProviderAdapter[]): ReadonlyMap<string, IAIProviderAdapter> {
	const providersById = new Map<string, IAIProviderAdapter>();
	for (const provider of providers) {
		if (providersById.has(provider.id)) {
			throw new Error(`Duplicate AI provider id: ${provider.id}.`);
		}
		providersById.set(provider.id, provider);
	}
	return providersById;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0;
}

function isExecutionMode(value: unknown): value is AIExecutionMode {
	return (AI_EXECUTION_MODES as readonly unknown[]).includes(value);
}

/**
 * Returns a description of the first problem with `request`, or `undefined`
 * if it is valid.
 */
function validateRequest(request: IAIMessageRequest): string | undefined {
	if (typeof request !== 'object' || request === null) {
		return 'Request must be an object.';
	}
	if (!isNonEmptyString(request.threadId)) {
		return 'Thread id must be a non-empty string.';
	}
	if (!isNonEmptyString(request.providerId)) {
		return 'Provider id must be a non-empty string.';
	}
	if (!isExecutionMode(request.mode)) {
		return `Unknown mode: ${String(request.mode)}. Expected one of ${AI_EXECUTION_MODES.join(', ')}.`;
	}
	if (!isNonEmptyString(request.prompt) || request.prompt.trim().length === 0) {
		return 'Prompt must not be empty.';
	}
	if (request.model !== undefined && !isNonEmptyString(request.model)) {
		return 'Model must be a non-empty string when given.';
	}
	return undefined;
}
