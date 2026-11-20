/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { supportsAgentHostDetachedWorktrees, type IAgentHostExtensionInitializeResult } from '../../../../platform/agentHost/common/agentHostExtensionProtocol.js';

/** The slice of an Agent Host connection this command needs. */
export interface IDetachableWorktreeConnection {
	readonly initializeResult: { get(): { readonly _meta?: Record<string, unknown> } | undefined };
	createDetachedWorktree?(session: URI, prompt: string): Promise<{ handle: string; worktree: URI }>;
	claimDetachedWorktree?(handle: string): Promise<void>;
}

/** The focused main-window chat, as far as worktree isolation needs to know. */
export interface IIsolateChatWorktreeTarget {
	readonly provider: string | undefined;
	readonly untitled: boolean;
	readonly prompt: string;
	readonly workingDirectory: URI | undefined;
	/** Current session isolation, when the workbench already knows it. */
	readonly isolation: string | undefined;
	readonly backendSession: URI | undefined;
	readonly connection: IDetachableWorktreeConnection | undefined;
}

export interface IIsolateChatWorktreeEffects {
	/** Creates the untitled backend session when the chat does not have one yet. */
	ensureBackend(workingDirectory: URI | undefined): Promise<URI | undefined>;
	/** Records worktree isolation so the host creates the checkout on the next send. */
	setWorktreeIsolation(workingDirectory: URI | undefined): Promise<boolean>;
}

export type IIsolateChatWorktreeResult =
	| { readonly outcome: 'already' }
	| { readonly outcome: 'detached'; readonly worktree: URI }
	| { readonly outcome: 'configured' }
	| { readonly outcome: 'unsupported' };

/**
 * Opts an Agent Host chat into a detached worktree.
 *
 * `createDetachedWorktree` only succeeds while the session is still being created
 * and is already pending a worktree. A normal chat is not pending, so a refused
 * call records worktree isolation and the host creates the checkout on the next send.
 * Chats that are already isolated are left alone.
 */
export async function isolateAgentHostChatInWorktree(target: IIsolateChatWorktreeTarget, effects: IIsolateChatWorktreeEffects): Promise<IIsolateChatWorktreeResult> {
	if (!target.provider) {
		return { outcome: 'unsupported' };
	}
	if (target.isolation === 'worktree') {
		return { outcome: 'already' };
	}

	let backend = target.backendSession;
	if (!backend && target.untitled) {
		backend = await effects.ensureBackend(target.workingDirectory);
	}

	const connection = target.connection;
	if (backend && connection?.createDetachedWorktree && supportsAgentHostDetachedWorktrees(connection.initializeResult.get() as IAgentHostExtensionInitializeResult | undefined)) {
		try {
			const created = await connection.createDetachedWorktree(backend, target.prompt);
			await connection.claimDetachedWorktree?.(created.handle);
			return { outcome: 'detached', worktree: created.worktree };
		} catch {
			// The session is not a creating worktree draft. Isolation below
			// makes the host create the checkout on the next send.
		}
	}

	const configured = await effects.setWorktreeIsolation(target.workingDirectory);
	return configured ? { outcome: 'configured' } : { outcome: 'unsupported' };
}
