/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NexusIDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { timeout } from '../../../base/common/async.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { IAIMessageRequest } from './ai.js';
import { IAIProviderAdapter, IAIRunSink } from './aiProvider.js';

export const ECHO_PROVIDER_ID = 'echo';

/**
 * Delay between two echoed pieces, so the reply arrives as a stream the way a
 * real provider's reply does.
 */
const DEFAULT_ECHO_DELAY_MS = 30;

/**
 * Development-only provider that replies with the prompt itself, one word at a
 * time. It lets the AI service, IPC channel and UI be exercised without a real
 * AI backend. It is not registered in built (packaged) products.
 */
export class EchoProvider implements IAIProviderAdapter {

	readonly id = ECHO_PROVIDER_ID;
	readonly displayName = 'Echo (development)';
	readonly kind = 'cli' as const;

	constructor(private readonly delayMs: number = DEFAULT_ECHO_DELAY_MS) { }

	async isAvailable(): Promise<boolean> {
		return true;
	}

	async run(request: IAIMessageRequest, sink: IAIRunSink, token: CancellationToken): Promise<void> {
		// Split into words while keeping the whitespace, so the pieces join back
		// into the original prompt.
		const pieces = request.prompt.match(/\S+\s*|\s+/g) ?? [];
		for (const piece of pieces) {
			if (token.isCancellationRequested) {
				return;
			}
			sink.text(piece);
			if (this.delayMs > 0) {
				await timeout(this.delayMs, token);
			}
		}
	}
}
