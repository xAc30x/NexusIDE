/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from 'fs';
import { join, relative, sep } from 'path';

/**
 * Default denylist, in gitignore syntax. `.nexusignore` is the `.cursorignore`
 * equivalent. There is no `.nexusindexingignore`.
 */
const DEFAULT_DENYLIST = `
.git/
.hg/
.svn/
.bzr/
node_modules/
.venv/
venv/
virtualenv/
__pycache__/
.pytest_cache/
.mypy_cache/
.ruff_cache/
.cache/
.tox/
.next/
.turbo/
.parcel-cache/
coverage/
.nyc_output/
*.lock
package-lock.json
pnpm-lock.yaml
npm-shrinkwrap.json
yarn.lock
Cargo.lock
Gemfile.lock
composer.lock
poetry.lock
.env*
*.png
*.jpg
*.jpeg
*.gif
*.webp
*.ico
*.mp3
*.mp4
*.mov
*.wav
*.avi
*.mkv
*.webm
*.exe
*.dll
*.so
*.dylib
*.wasm
*.class
*.o
*.a
*.obj
*.pdb
*.zip
*.gz
*.tgz
*.7z
*.pdf
*.woff
*.woff2
*.ttf
*.eot
*.bin
*.pyc
*.pyo
`;

interface IRule {
	readonly base: string;
	readonly regex: RegExp;
	readonly negation: boolean;
	readonly dirOnly: boolean;
	matches(rel: string): boolean;
}

interface ICachedRules {
	readonly stamp: string;
	readonly rules: readonly IRule[];
}

const rootRuleCache = new Map<string, ICachedRules>();

export class IgnoreSet {
	constructor(readonly rules: readonly IRule[]) { }

	ignores(rel: string, isDir: boolean): boolean {
		const normalized = rel.split('\\').join('/').replace(/^\.\//, '').replace(/\/$/, '');
		if (!normalized || normalized === '.') {
			return false;
		}
		const segments = normalized.split('/');
		let ignored = false;
		let walking = '';
		for (let i = 0; i < segments.length; i++) {
			walking = i === 0 ? segments[0] : `${walking}/${segments[i]}`;
			const asDir = i < segments.length - 1 || isDir;
			for (const rule of this.rules) {
				if (rule.dirOnly && !asDir) {
					continue;
				}
				if (rule.matches(walking)) {
					ignored = !rule.negation;
				}
			}
			if (ignored && i < segments.length - 1) {
				return true;
			}
		}
		return ignored;
	}
}

export function loadIgnore(root: string): IgnoreSet {
	return new IgnoreSet(rootRules(root));
}

/** Ignored paths stay blocked for the agent and for `@` mentions. */
export function isBlockedForAgent(root: string, relativePath: string): boolean {
	const rel = normalizeRel(relativePath);
	if (!rel) {
		return false;
	}
	const rules = [...rootRules(root)];
	const parts = rel.split('/');
	let base = '';
	for (let i = 0; i < parts.length - 1; i++) {
		base = base ? `${base}/${parts[i]}` : parts[i];
		rules.push(...readIgnoreFile(join(root, base, '.gitignore'), base));
		rules.push(...readIgnoreFile(join(root, base, '.nexusignore'), base));
	}
	let isDir = false;
	try {
		isDir = statSync(join(root, rel)).isDirectory();
	} catch {
		isDir = false;
	}
	return new IgnoreSet(rules).ignores(rel, isDir);
}

/**
 * Literal `!` paths in `.nexusignore`. Ripgrep will not return a gitignored
 * file, so `@` mentions add these back when the negation keeps them visible.
 */
export function negatedMentionPaths(root: string): readonly string[] {
	const file = join(root, '.nexusignore');
	let text: string;
	try {
		text = readFileSync(file, 'utf8');
	} catch {
		return [];
	}
	const paths: string[] = [];
	for (const line of text.split('\n')) {
		const trimmed = line.replace(/\r$/, '').trim();
		if (!trimmed.startsWith('!') || /[*?[]/.test(trimmed)) {
			continue;
		}
		let rel = trimmed.slice(1).replace(/^\//, '');
		if (!rel || rel.endsWith('/')) {
			continue;
		}
		rel = normalizeRel(rel);
		const abs = join(root, rel);
		try {
			if (statSync(abs).isFile() && !isBlockedForAgent(root, rel)) {
				paths.push(rel);
			}
		} catch {
			// The negation names a file that is not on disk.
		}
	}
	return paths;
}

export interface IWalkOptions {
	/** Index builds stay in this checkout. A direct scan enters nested checkouts. */
	readonly enterNestedRepos?: boolean;
	/**
	 * Ignore files are read from this directory. `rel` passed to `visit` stays
	 * relative to {@link root}. Defaults to `root`.
	 */
	readonly ruleRoot?: string;
}

export function walkIncluded(root: string, visit: (rel: string, abs: string) => void, options?: IWalkOptions): void {
	const ruleRoot = options?.ruleRoot ?? root;
	const rules = [...rootRules(ruleRoot)];
	const rootRel = normalizeRel(relativePosix(ruleRoot, root));
	if (rootRel && rootRel !== '.') {
		let base = '';
		for (const part of rootRel.split('/')) {
			base = base ? `${base}/${part}` : part;
			rules.push(...readIgnoreFile(join(ruleRoot, base, '.gitignore'), base));
			rules.push(...readIgnoreFile(join(ruleRoot, base, '.nexusignore'), base));
		}
	}
	const walk = (dir: string, rel: string) => {
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		const mark = rules.length;
		const ruleRel = rootRel && rootRel !== '.' ? (rel ? `${rootRel}/${rel}` : rootRel) : rel;
		if (rel) {
			rules.push(...readIgnoreFile(join(dir, '.gitignore'), ruleRel));
			rules.push(...readIgnoreFile(join(dir, '.nexusignore'), ruleRel));
		}
		const ignore = new IgnoreSet(rules);
		for (const entry of entries) {
			if (entry.name === '.git' || entry.isSymbolicLink()) {
				continue;
			}
			const childRel = rel ? `${rel}/${entry.name}` : entry.name;
			const childRuleRel = rootRel && rootRel !== '.' ? `${rootRel}/${childRel}` : childRel;
			const isDir = entry.isDirectory();
			if (ignore.ignores(childRuleRel, isDir)) {
				continue;
			}
			const abs = join(dir, entry.name);
			if (isDir) {
				if (!options?.enterNestedRepos && existsSync(join(abs, '.git'))) {
					continue;
				}
				walk(abs, childRel);
			} else if (entry.isFile()) {
				visit(childRel, abs);
			}
		}
		rules.length = mark;
	};
	walk(root, '');
}

function rootRules(root: string): readonly IRule[] {
	const stamp = fileStamp(join(root, '.gitignore')) + '|' + fileStamp(join(root, '.nexusignore'));
	const cached = rootRuleCache.get(root);
	if (cached && cached.stamp === stamp) {
		return cached.rules;
	}
	const rules = [
		...parseText(DEFAULT_DENYLIST, ''),
		...readIgnoreFile(join(root, '.gitignore'), ''),
		...readIgnoreFile(join(root, '.nexusignore'), ''),
	];
	rootRuleCache.set(root, { stamp, rules });
	return rules;
}

function fileStamp(file: string): string {
	try {
		const stat = statSync(file);
		return `${stat.mtimeMs}:${stat.size}`;
	} catch {
		return '0';
	}
}

function readIgnoreFile(file: string, base: string): IRule[] {
	try {
		return parseText(readFileSync(file, 'utf8'), base);
	} catch {
		return [];
	}
}

function parseText(text: string, base: string): IRule[] {
	const rules: IRule[] = [];
	for (const line of text.split('\n')) {
		const rule = parseLine(line, base);
		if (rule) {
			rules.push(rule);
		}
	}
	return rules;
}

function parseLine(line: string, base: string): IRule | undefined {
	let text = line.replace(/\r$/, '').replace(/(?<!\\)[ \t]+$/, '');
	if (!text || text.startsWith('#')) {
		return undefined;
	}
	let negation = false;
	if (text.startsWith('!')) {
		negation = true;
		text = text.slice(1);
	} else if (text.startsWith('\\!')) {
		text = text.slice(1);
	}
	if (text.startsWith('\\#')) {
		text = text.slice(1);
	}
	const dirOnly = text.endsWith('/');
	if (dirOnly) {
		text = text.slice(0, -1);
	}
	if (!text) {
		return undefined;
	}
	const anchored = text.startsWith('/') || text.slice(0, text.endsWith('/') ? -1 : undefined).includes('/');
	if (text.startsWith('/')) {
		text = text.slice(1);
	}
	const body = compileBody(text);
	const source = anchored ? `^${body}$` : `(?:^|/)${body}$`;
	const regex = new RegExp(source);
	return {
		base,
		regex,
		negation,
		dirOnly,
		matches(rel: string): boolean {
			let local = rel;
			if (base) {
				const prefix = `${base}/`;
				if (!rel.startsWith(prefix)) {
					return false;
				}
				local = rel.slice(prefix.length);
			}
			return regex.test(local);
		},
	};
}

function compileBody(pattern: string): string {
	let out = '';
	for (let i = 0; i < pattern.length; i++) {
		const char = pattern[i];
		if (char === '*' && pattern[i + 1] === '*') {
			if (pattern[i + 2] === '/') {
				out += '(?:.*/)?';
				i += 2;
				continue;
			}
			out += '.*';
			i++;
			continue;
		}
		if (char === '*') {
			out += '[^/]*';
			continue;
		}
		if (char === '?') {
			out += '[^/]';
			continue;
		}
		out += escapeRegex(char);
	}
	return out;
}

function escapeRegex(char: string): string {
	return /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}

function normalizeRel(relativePath: string): string {
	return relativePath.split('\\').join('/').replace(/^\.\//, '').replace(/\/$/, '');
}

function relativePosix(root: string, target: string): string {
	const rel = relative(root, target);
	return !rel ? '' : rel.split(sep).join('/');
}
