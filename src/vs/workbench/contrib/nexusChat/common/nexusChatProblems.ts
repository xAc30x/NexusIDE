/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NexusIDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isEqualOrParent, relativePath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IMarker, MarkerSeverity } from '../../../../platform/markers/common/markers.js';

/** Most problems sent with one message. */
export const MAX_PROBLEMS = 50;

/** Most characters of problem lines sent with one message. */
export const MAX_PROBLEMS_LENGTH = 8_000;

export interface INexusChatProblems {
	/** The problems as a `<problems>` block for the AI. */
	readonly text: string;
	/** Number of problems in {@link text}. */
	readonly included: number;
}

/**
 * Formats the errors and warnings inside `folder` for the AI, errors first,
 * with paths relative to the folder. At most {@link MAX_PROBLEMS} problems
 * and about {@link MAX_PROBLEMS_LENGTH} characters are included; the rest is
 * counted in a last line. Returns `undefined` when there is no problem.
 *
 * The text is meant for the AI, not for the user, so it is not localized.
 */
export function formatProblems(markers: readonly IMarker[], folder: URI): INexusChatProblems | undefined {
	const problems = markers
		.filter(marker => (marker.severity === MarkerSeverity.Error || marker.severity === MarkerSeverity.Warning) && isEqualOrParent(marker.resource, folder))
		.map(marker => ({ marker, path: relativePath(folder, marker.resource) ?? marker.resource.path }))
		.sort((a, b) => MarkerSeverity.compare(a.marker.severity, b.marker.severity)
			|| a.path.localeCompare(b.path)
			|| a.marker.startLineNumber - b.marker.startLineNumber
			|| a.marker.startColumn - b.marker.startColumn);
	if (problems.length === 0) {
		return undefined;
	}

	const lines: string[] = [];
	let length = 0;
	for (const { marker, path } of problems) {
		const line = formatProblem(marker, path);
		if (lines.length >= MAX_PROBLEMS || length + line.length > MAX_PROBLEMS_LENGTH) {
			break;
		}
		lines.push(line);
		length += line.length;
	}
	const omitted = problems.length - lines.length;
	if (omitted > 0) {
		lines.push(`... and ${omitted} more`);
	}
	return {
		text: `<problems source="NexusIDE Problems panel">\n${lines.join('\n')}\n</problems>`,
		included: problems.length - omitted,
	};
}

function formatProblem(marker: IMarker, path: string): string {
	const severity = marker.severity === MarkerSeverity.Error ? 'error' : 'warning';
	const code = typeof marker.code === 'string' ? marker.code : marker.code?.value;
	const origin = [marker.source, code].filter(part => part !== undefined && part.length > 0).join(' ');
	// One line per problem, and no message can end the block early.
	const message = marker.message.replace(/\s+/g, ' ').replace(/<\/?problems/gi, '[problems').trim();
	return `${path}:${marker.startLineNumber}:${marker.startColumn} ${severity}: ${message}${origin ? ` (${origin})` : ''}`;
}
