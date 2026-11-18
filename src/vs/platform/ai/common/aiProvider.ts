/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NexusIDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../base/common/cancellation.js';
import { AIExecutionMode, AIPermissionDecision, AIProviderKind, IAIMessageRequest } from './ai.js';

/**
 * A tool use that a provider needs the user to approve before it happens.
 */
export interface IAIPermissionRequest {
	/** Provider-specific tool name, for example `Edit` or `Bash`. */
	readonly toolName: string;
	/** One line shown to the user, for example `Edit src/app.ts`. */
	readonly summary: string;
	/** Optional longer text, for example the full command line. */
	readonly detail?: string;
}

/**
 * Receives the output of a provider run.
 */
export interface IAIRunSink {
	/** Adds reply text. */
	text(text: string): void;
	/** Reports a tool the provider used, as a one-line summary, and whether it failed or was denied. */
	toolUse(summary: string, failed: boolean): void;
	/**
	 * Asks the user to approve a tool use. Resolves with `deny` when the run is
	 * cancelled or ends before the user answers.
	 */
	requestPermission(request: IAIPermissionRequest): Promise<AIPermissionDecision>;
}

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
	 * Produces the reply to `request`, passing its output to `sink` as it
	 * arrives.
	 *
	 * Resolves when the reply is complete. When `token` is cancelled the adapter
	 * should stop its work and then resolve or reject with a cancellation
	 * error. Rejects with an error describing the failure otherwise.
	 */
	run(request: IAIMessageRequest, sink: IAIRunSink, token: CancellationToken): Promise<void>;
}
