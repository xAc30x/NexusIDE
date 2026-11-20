/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Tool, ToolResultObject } from '@github/copilot-sdk';
import { getErrorMessage } from '../../../../base/common/errors.js';
import { URI } from '../../../../base/common/uri.js';
import { dispatchInstantGrep, getSharedInstantGrepHost, instantGrepRequestFromRecord } from '../instantGrep/instantGrepHost.js';

export interface ICopilotInstantGrepContext {
	roots(): readonly URI[];
	enabled(): boolean;
	restricted(): boolean;
}

/**
 * Disk override for the runtime's built-in grep and glob. Virtual sessions
 * keep their own filesystem tools; this is the one Instant Grep path.
 */
export function createCopilotInstantGrepTools(context: ICopilotInstantGrepContext): [grep: Tool<unknown>, glob: Tool<unknown>] {
	const run = async (kind: 'grep' | 'glob', args: Record<string, unknown>): Promise<ToolResultObject> => {
		try {
			const roots = context.roots().filter(root => root.scheme === 'file').map(root => root.fsPath);
			const result = await dispatchInstantGrep(getSharedInstantGrepHost(), instantGrepRequestFromRecord(kind, roots, args, context.enabled(), context.restricted()));
			return { resultType: 'success', textResultForLlm: result.text };
		} catch (error) {
			const message = getErrorMessage(error);
			return { resultType: 'failure', textResultForLlm: message, error: message };
		}
	};

	return [{
		name: 'grep',
		description: 'Search file contents with a JavaScript regular expression. Use glob for file names.',
		parameters: {
			type: 'object',
			properties: {
				pattern: { type: 'string', description: 'JavaScript regular expression to match.' },
				paths: {
					anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
					description: 'Directories or files to search. Defaults to the working directory.',
				},
				glob: { type: 'string', description: 'Include files matching this glob.' },
				'-i': { type: 'boolean', description: 'Case-insensitive search.' },
			},
			required: ['pattern'],
			additionalProperties: false,
		},
		overridesBuiltInTool: true,
		skipPermission: true,
		defer: 'auto',
		handler: (args: unknown) => run('grep', record(args)),
	}, {
		name: 'glob',
		description: 'Find files by glob pattern. Use for file names and paths; use grep for contents.',
		parameters: {
			type: 'object',
			properties: {
				pattern: { type: 'string', description: 'Glob pattern, for example **/*.ts.' },
				paths: {
					anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
					description: 'Directories to search. Defaults to the working directory.',
				},
			},
			required: ['pattern'],
			additionalProperties: false,
		},
		overridesBuiltInTool: true,
		skipPermission: true,
		defer: 'auto',
		handler: (args: unknown) => run('glob', record(args)),
	}];
}

function record(args: unknown): Record<string, unknown> {
	return args && typeof args === 'object' ? args as Record<string, unknown> : {};
}
