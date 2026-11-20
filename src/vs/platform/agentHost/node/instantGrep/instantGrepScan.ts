/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync, statSync } from 'fs';
import { basename, relative, sep } from 'path';
import { parse } from '../../../../base/common/glob.js';
import { isBlockedForAgent, walkIncluded } from './instantGrepIgnore.js';

const MAX_LINE = 2000;

export interface IGrepMatch {
	readonly path: string;
	readonly line: number;
	readonly text: string;
}

export interface IScanRequest {
	readonly kind: 'grep' | 'glob';
	/** Paths in the result are relative to this directory. */
	readonly reportRoot: string;
	/** `.gitignore` and `.nexusignore` are read from this directory. */
	readonly ignoreRoot: string;
	readonly scope: string;
	readonly pattern: string;
	readonly glob?: string;
	readonly caseInsensitive?: boolean;
}

/** The direct scan matches names. It does not require an index. */
export function directScan(request: IScanRequest): { matches: IGrepMatch[]; paths: string[] } {
	const scopeRel = relativeTo(request.ignoreRoot, request.scope);
	if (scopeRel.startsWith('..')) {
		return { matches: [], paths: [] };
	}
	let scopeIsFile = false;
	try {
		scopeIsFile = statSync(request.scope).isFile();
	} catch {
		return { matches: [], paths: [] };
	}
	if (scopeRel && isBlockedForAgent(request.ignoreRoot, scopeRel)) {
		return { matches: [], paths: [] };
	}

	const nameMatcher = request.kind === 'glob' ? parse(request.pattern) : undefined;
	const globMatcher = request.kind === 'grep' && request.glob ? parse(request.glob) : undefined;
	const regex = request.kind === 'grep' ? new RegExp(request.pattern, request.caseInsensitive ? 'i' : '') : undefined;
	const matches: IGrepMatch[] = [];
	const paths: string[] = [];

	const consider = (abs: string) => {
		const ignoreRel = relativeTo(request.ignoreRoot, abs);
		if (!ignoreRel || ignoreRel.startsWith('..') || isBlockedForAgent(request.ignoreRoot, ignoreRel)) {
			return;
		}
		const rel = relativeTo(request.reportRoot, abs);
		if (!rel || rel.startsWith('..')) {
			return;
		}
		if (request.kind === 'glob') {
			if (nameMatcher!(rel) || nameMatcher!(basename(rel))) {
				paths.push(rel);
			}
			return;
		}
		if (globMatcher && !(globMatcher(rel) || globMatcher(basename(rel)))) {
			return;
		}
		const bytes = readFileSync(abs);
		if (bytes.includes(0)) {
			return;
		}
		for (const hit of matchLines(bytes.toString('utf8'), regex!)) {
			matches.push({ path: rel, line: hit.line, text: hit.text });
		}
	};

	if (scopeIsFile) {
		consider(request.scope);
		return { matches, paths };
	}

	walkIncluded(request.scope, (_rel, abs) => consider(abs), {
		enterNestedRepos: true,
		ruleRoot: request.ignoreRoot,
	});
	return { matches, paths };
}

export function matchLines(text: string, regex: RegExp): { line: number; text: string }[] {
	const lines = text.split(/\r?\n/);
	const hits: { line: number; text: string }[] = [];
	for (let i = 0; i < lines.length; i++) {
		regex.lastIndex = 0;
		if (regex.test(lines[i])) {
			hits.push({ line: i + 1, text: lines[i].slice(0, MAX_LINE) });
		}
	}
	return hits;
}

export function relativeTo(root: string, target: string): string {
	const rel = relative(root, target);
	if (!rel) {
		return '';
	}
	return rel.split(sep).join('/');
}
