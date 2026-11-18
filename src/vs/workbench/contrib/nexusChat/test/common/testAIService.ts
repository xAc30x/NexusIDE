/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NexusIDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { AIPermissionDecision, AIResult, IAIMessageRequest, IAIProviderInfo, IAIRunHandle, IAIService, IAIStreamDelta, IAIStreamReadResult } from '../../../../../platform/ai/common/ai.js';
import { IStreamHubOptions, StreamHub } from '../../../../../platform/ai/common/streamHub.js';

/**
 * AI service backed by a real StreamHub. Tests append to streams directly and
 * can drop events or replace responses to simulate IPC problems.
 */
export class TestAIService extends Disposable implements IAIService {

	declare readonly _serviceBrand: undefined;

	readonly hub: StreamHub;

	private readonly _onDidStreamDelta = this._register(new Emitter<IAIStreamDelta>());
	readonly onDidStreamDelta: Event<IAIStreamDelta> = this._onDidStreamDelta.event;

	/** Returned by `listProviders`. */
	providers: readonly IAIProviderInfo[] = [];
	/** When false, stream events are dropped, as if they were lost. */
	deliverEvents = true;
	/** Replaces the default response of `sendMessage`. */
	sendResponse: ((request: IAIMessageRequest) => Promise<AIResult<IAIRunHandle>>) | undefined;
	/** Replaces the default response of `readStream`. */
	readResponse: (() => Promise<AIResult<IAIStreamReadResult>>) | undefined;

	readonly requests: IAIMessageRequest[] = [];
	readonly cancelledThreads: string[] = [];
	readonly readCursors: number[] = [];
	readonly permissionAnswers: { readonly threadId: string; readonly requestId: string; readonly decision: AIPermissionDecision }[] = [];
	/** Ids of the streams created by `sendMessage`, in order. */
	readonly streamIds: string[] = [];

	constructor(options?: Partial<IStreamHubOptions>) {
		super();
		this.hub = this._register(new StreamHub(options));
		this._register(this.hub.onDidAppend(delta => {
			if (this.deliverEvents) {
				this._onDidStreamDelta.fire(delta);
			}
		}));
	}

	/** Fires an event directly, for example to repeat chunks. */
	fireDelta(delta: IAIStreamDelta): void {
		this._onDidStreamDelta.fire(delta);
	}

	createStream(): string {
		return this.hub.createStream();
	}

	async listProviders(): Promise<AIResult<readonly IAIProviderInfo[]>> {
		return { ok: true, value: this.providers };
	}

	async sendMessage(request: IAIMessageRequest): Promise<AIResult<IAIRunHandle>> {
		this.requests.push(request);
		if (this.sendResponse) {
			return this.sendResponse(request);
		}
		const streamId = this.hub.createStream();
		this.streamIds.push(streamId);
		return { ok: true, value: { threadId: request.threadId, streamId } };
	}

	async readStream(streamId: string, fromCursor: number): Promise<AIResult<IAIStreamReadResult>> {
		this.readCursors.push(fromCursor);
		if (this.readResponse) {
			return this.readResponse();
		}
		return this.hub.read(streamId, fromCursor);
	}

	async cancelRun(threadId: string): Promise<AIResult<boolean>> {
		this.cancelledThreads.push(threadId);
		return { ok: true, value: true };
	}

	async respondToPermission(threadId: string, requestId: string, decision: AIPermissionDecision): Promise<AIResult<boolean>> {
		this.permissionAnswers.push({ threadId, requestId, decision });
		return { ok: true, value: true };
	}
}
