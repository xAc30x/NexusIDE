/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ChatMode } from '../../common/chatModes.js';
import { claudePermissionModeForChatModeChange } from '../../common/claudePlanPermission.js';

suite('claudePermissionModeForChatModeChange', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('selecting Plan enters plan mode and leaving it restores the default', () => {
		assert.deepStrictEqual({
			initialPlan: claudePermissionModeForChatModeChange(undefined, ChatMode.Plan.id),
			agentToPlan: claudePermissionModeForChatModeChange(ChatMode.Agent.id, ChatMode.Plan.id),
			planAgain: claudePermissionModeForChatModeChange(ChatMode.Plan.id, ChatMode.Plan.id),
			planToAgent: claudePermissionModeForChatModeChange(ChatMode.Plan.id, ChatMode.Agent.id),
			planToAsk: claudePermissionModeForChatModeChange(ChatMode.Plan.id, ChatMode.Ask.id),
			agentToAsk: claudePermissionModeForChatModeChange(ChatMode.Agent.id, ChatMode.Ask.id),
			initialAgent: claudePermissionModeForChatModeChange(undefined, ChatMode.Agent.id),
		}, {
			initialPlan: 'plan',
			agentToPlan: 'plan',
			planAgain: undefined,
			planToAgent: 'default',
			planToAsk: 'default',
			agentToAsk: undefined,
			initialAgent: undefined,
		});
	});
});
