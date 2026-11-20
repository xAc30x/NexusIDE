/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Counts the renderer may show for Instant Grep. The hash table stays in the
 * Agent Host; this status is the only view that crosses to the renderer.
 */
export interface IInstantGrepStatus {
	readonly commitDocuments: number;
	readonly worktreeDocuments: number;
}
