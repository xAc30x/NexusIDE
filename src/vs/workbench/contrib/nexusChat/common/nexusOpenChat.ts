/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NexusIDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AI_EXECUTION_MODES, AIExecutionMode } from '../../../../platform/ai/common/ai.js';

/** Opens the sidebar chat and focuses it. */
export const NEXUS_CHAT_SHOW_COMMAND_ID = 'nexusChat.showChat';

/** Sets the chat mode. Argument is an {@link AIExecutionMode}. */
export const NEXUS_CHAT_SET_MODE_COMMAND_ID = 'nexusChat.setMode';

/** Returns the open sidebar chat, if it has a user message. */
export const NEXUS_CHAT_GET_OPEN_CHAT_COMMAND_ID = 'nexusChat.getOpenChat';

/** Starts a new sidebar chat. */
export const NEXUS_CHAT_NEW_CHAT_COMMAND_ID = 'nexusChat.newChat';

/**
 * The chat the command palette can list. The title is the first line of the
 * first user message. `updatedAt` is when that chat last changed.
 */
export interface INexusOpenChat {
	readonly title: string;
	readonly updatedAt: number;
}

export function isNexusChatMode(value: unknown): value is AIExecutionMode {
	return typeof value === 'string' && (AI_EXECUTION_MODES as readonly string[]).includes(value);
}
