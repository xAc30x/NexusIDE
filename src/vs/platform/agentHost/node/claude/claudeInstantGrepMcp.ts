/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import type { IClaudeAgentSdkService } from './claudeAgentSdkService.js';
import { jsonSchemaToZodRawShape } from './clientTools/claudeJsonSchemaToZod.js';
import { dispatchInstantGrep, getSharedInstantGrepHost, instantGrepRequestFromRecord } from '../instantGrep/instantGrepHost.js';

/** In-process MCP server that replaces the Claude SDK's built-in Grep and Glob. */
export const CLAUDE_INSTANT_GREP_MCP_SERVER_NAME = 'instant_grep';

export function claudeInstantGrepAllowList(): string[] {
	return ['Grep', 'Glob'].map(name => `mcp__${CLAUDE_INSTANT_GREP_MCP_SERVER_NAME}__${name}`);
}

const grepSchema = {
	type: 'object' as const,
	properties: {
		pattern: { type: 'string', description: 'JavaScript regular expression to match.' },
		path: { type: 'string', description: 'Directory or file to search. Defaults to the working directory.' },
		glob: { type: 'string', description: 'Include files matching this glob.' },
		'-i': { type: 'boolean', description: 'Case-insensitive search.' },
	},
	required: ['pattern'],
};

const globSchema = {
	type: 'object' as const,
	properties: {
		pattern: { type: 'string', description: 'Glob pattern, for example **/*.ts.' },
		path: { type: 'string', description: 'Directory to search. Defaults to the working directory.' },
	},
	required: ['pattern'],
};

/**
 * Claude-only bridge onto the Agent Host grep implementation. The SDK builtins
 * are disallowed, so this server is the search the model calls.
 */
export async function buildClaudeInstantGrepMcpServer(
	sdk: IClaudeAgentSdkService,
	roots: () => readonly string[],
	enabled: () => boolean,
	restricted: () => boolean,
): Promise<McpSdkServerConfigWithInstance> {
	const call = async (kind: 'grep' | 'glob', args: Record<string, unknown>) => {
		const result = await dispatchInstantGrep(
			getSharedInstantGrepHost(),
			instantGrepRequestFromRecord(kind, [...roots()], args, enabled(), restricted()),
		);
		return { content: [{ type: 'text' as const, text: result.text }] };
	};
	const tools = await Promise.all([
		sdk.tool('Grep', 'Search file contents with a JavaScript regular expression. Use Glob for file names.', jsonSchemaToZodRawShape(grepSchema), async args => call('grep', args as Record<string, unknown>)),
		sdk.tool('Glob', 'Find files by glob pattern. Use for file names and paths; use Grep for contents.', jsonSchemaToZodRawShape(globSchema), async args => call('glob', args as Record<string, unknown>)),
	]);
	return sdk.createSdkMcpServer({ name: CLAUDE_INSTANT_GREP_MCP_SERVER_NAME, tools });
}
