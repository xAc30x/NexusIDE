/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChatMode } from './chatModes.js';
import { ClaudePermissionMode } from '../../../../platform/agentHost/common/claudeSessionConfigKeys.js';

/**
 * Permission mode to write when the chat mode changes on an Agent Host Claude session.
 *
 * Selecting Plan enters `plan`. Leaving Plan restores `default`, which asks before
 * tools. Other changes leave the current permission mode alone, so opening a chat
 * that is already in Agent does not clobber `acceptEdits`.
 */
export function claudePermissionModeForChatModeChange(previousModeId: string | undefined, nextModeId: string): Extract<ClaudePermissionMode, 'plan' | 'default'> | undefined {
	if (nextModeId === ChatMode.Plan.id) {
		return previousModeId === ChatMode.Plan.id ? undefined : 'plan';
	}
	if (previousModeId === ChatMode.Plan.id) {
		return 'default';
	}
	return undefined;
}
