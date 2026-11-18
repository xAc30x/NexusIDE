/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NexusIDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../base/common/cancellation.js';
import { AIExecutionMode, AIProviderKind, IAIMessageRequest } from './ai.js';

/**
 * A backend that {@link IAIService} can route requests to, for example the
 * local Claude CLI or an HTTP API. Adapters run in the main process.
 */
export interface IAIProviderAdapter {
	readonly id: string;
	readonly displayName: string;
	readonly kind: AIProviderKind;
	/**
	 * Modes this provider accepts. Requests in other modes are refused before
	 * a run starts. All modes are accepted when omitted.
	 */
	readonly supportedModes?: readonly AIExecutionMode[];

	/**
	 * Whether the provider can accept requests right now, for example because
	 * its CLI binary was found or an API key is stored.
	 */
	isAvailable(): Promise<boolean>;

	/**
	 * Produces the reply to `request`, passing text to `onText` as it arrives.
	 *
	 * Resolves when the reply is complete. When `token` is cancelled the adapter
	 * should stop its work and then resolve or reject with a cancellation
	 * error. Rejects with an error describing the failure otherwise.
	 */
	run(request: IAIMessageRequest, onText: (text: string) => void, token: CancellationToken): Promise<void>;
}
