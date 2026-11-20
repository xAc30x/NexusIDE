/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ToolDefinition } from '../../common/state/protocol/state.js';

/** Codex dynamic tools. The handler is the shared Instant Grep dispatch. */
export const instantGrepToolDefinitions: readonly ToolDefinition[] = [{
	name: 'grep',
	description: 'Search file contents with a JavaScript regular expression. Use glob for file names.',
	inputSchema: {
		type: 'object',
		properties: {
			pattern: { type: 'string', description: 'JavaScript regular expression to match.' },
			path: { type: 'string', description: 'Directory or file to search. Defaults to the working directory.' },
			glob: { type: 'string', description: 'Include files matching this glob.' },
			'-i': { type: 'boolean', description: 'Case-insensitive search.' },
		},
		required: ['pattern'],
	},
}, {
	name: 'glob',
	description: 'Find files by glob pattern. Use for file names and paths; use grep for contents.',
	inputSchema: {
		type: 'object',
		properties: {
			pattern: { type: 'string', description: 'Glob pattern, for example **/*.ts.' },
			path: { type: 'string', description: 'Directory to search. Defaults to the working directory.' },
		},
		required: ['pattern'],
	},
}];
