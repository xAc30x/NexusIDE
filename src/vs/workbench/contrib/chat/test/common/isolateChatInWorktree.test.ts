/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { IAgentHostExtensionInitializeResult } from '../../../../../platform/agentHost/common/agentHostExtensionProtocol.js';
import { isolateAgentHostChatInWorktree, type IDetachableWorktreeConnection } from '../../common/isolateChatInWorktree.js';

suite('isolateAgentHostChatInWorktree', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const session = URI.from({ scheme: 'agent-host-claude', path: '/untitled-1' });
	const folder = URI.file('/workspace');
	const worktree = URI.file('/workspace/.worktrees/chat');

	function connection(create: IDetachableWorktreeConnection['createDetachedWorktree']): { connection: IDetachableWorktreeConnection; claimed: string[] } {
		const claimed: string[] = [];
		return {
			claimed,
			connection: {
				initializeResult: { get: () => ({ _meta: { 'vscode.detachedWorktrees': true } }) as IAgentHostExtensionInitializeResult },
				createDetachedWorktree: create,
				claimDetachedWorktree: async handle => { claimed.push(handle); },
			},
		};
	}

	test('records worktree isolation when the host refuses a detached worktree', async () => {
		const host = connection(async () => { throw new Error('Session is not configured for worktree isolation'); });
		const isolations: Array<URI | undefined> = [];
		const result = await isolateAgentHostChatInWorktree({
			provider: 'claude',
			untitled: true,
			prompt: 'isolate',
			workingDirectory: folder,
			isolation: 'folder',
			backendSession: session,
			connection: host.connection,
		}, {
			ensureBackend: async () => session,
			setWorktreeIsolation: async directory => {
				isolations.push(directory);
				return true;
			},
		});

		assert.deepStrictEqual({ result, isolations, claimed: host.claimed }, {
			result: { outcome: 'configured' },
			isolations: [folder],
			claimed: [],
		});
	});

	test('claims a detached worktree when the host creates one', async () => {
		const host = connection(async () => ({ handle: 'wt-1', worktree }));
		let isolated = false;
		const result = await isolateAgentHostChatInWorktree({
			provider: 'claude',
			untitled: false,
			prompt: 'isolate',
			workingDirectory: folder,
			isolation: undefined,
			backendSession: session,
			connection: host.connection,
		}, {
			ensureBackend: async () => undefined,
			setWorktreeIsolation: async () => {
				isolated = true;
				return true;
			},
		});

		assert.deepStrictEqual({ result, isolated, claimed: host.claimed }, {
			result: { outcome: 'detached', worktree },
			isolated: false,
			claimed: ['wt-1'],
		});
	});

	test('leaves a chat that is already isolated', async () => {
		let ensured = false;
		let isolated = false;
		const result = await isolateAgentHostChatInWorktree({
			provider: 'claude',
			untitled: true,
			prompt: 'isolate',
			workingDirectory: folder,
			isolation: 'worktree',
			backendSession: undefined,
			connection: undefined,
		}, {
			ensureBackend: async () => { ensured = true; return undefined; },
			setWorktreeIsolation: async () => { isolated = true; return true; },
		});

		assert.deepStrictEqual({ result, ensured, isolated }, {
			result: { outcome: 'already' },
			ensured: false,
			isolated: false,
		});
	});

	test('refuses a chat that is not backed by Agent Host', async () => {
		const result = await isolateAgentHostChatInWorktree({
			provider: undefined,
			untitled: true,
			prompt: 'isolate',
			workingDirectory: folder,
			isolation: undefined,
			backendSession: undefined,
			connection: undefined,
		}, {
			ensureBackend: async () => folder,
			setWorktreeIsolation: async () => true,
		});

		assert.deepStrictEqual(result, { outcome: 'unsupported' });
	});
});
