/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, watch, type FSWatcher } from 'fs';
import { dirname, isAbsolute, join, resolve, sep } from 'path';
import { parse } from '../../../../base/common/glob.js';
import type { IInstantGrepStatus } from '../../common/instantGrep.js';
import { cacheDirectory, chooseCachedSha, diffNameStatus, driftedFrom, findGitRoot, gitHead, isSubmodule, listCommitFiles, listSubmodules, readCommitFile } from './instantGrepGit.js';
import { mapIndex, writeIndex, type IIndexDocument, type IMappedIndex } from './instantGrepFormat.js';
import { loadIgnore, walkIncluded } from './instantGrepIgnore.js';
import { buildAll, buildCovering, fnv1a64, literalGroups } from './instantGrepNgrams.js';
import { directScan, matchLines, relativeTo, type IGrepMatch } from './instantGrepScan.js';

const MAX_RESULTS = 200;
const MAX_NGRAM_BYTES = 1024 * 1024;
const DELETED: ILayerEntry = { kind: 'delete', text: '', mustScan: false };

export interface IInstantGrepHostOptions {
	readonly watch?: boolean;
	readonly failBuild?: boolean;
	readonly hash?: (gram: string) => bigint;
}

export interface IInstantGrepRequest {
	readonly kind: 'grep' | 'glob';
	readonly roots: readonly string[];
	readonly paths?: readonly string[];
	readonly pattern: string;
	readonly glob?: string;
	readonly caseInsensitive?: boolean;
	readonly enabled: boolean;
	readonly restricted: boolean;
}

export interface IInstantGrepResult {
	readonly text: string;
	readonly source: 'index' | 'scan';
	readonly generation: number;
}

interface ILayerEntry {
	readonly kind: 'add' | 'modify' | 'delete';
	readonly text: string;
	readonly mustScan: boolean;
}

interface IRepoState {
	readonly sha: string;
	readonly indexDir: string;
	readonly baseline: ReadonlySet<string>;
	readonly layer: Map<string, ILayerEntry>;
}

const TOOL_NAMES = new Set(['grep', 'glob', 'Grep', 'Glob']);

export function isInstantGrepToolName(name: string): boolean {
	return TOOL_NAMES.has(name);
}

export function instantGrepKind(name: string): 'grep' | 'glob' {
	return name.toLowerCase() === 'glob' ? 'glob' : 'grep';
}

export function instantGrepRequestFromRecord(kind: 'grep' | 'glob', roots: readonly string[], args: Record<string, unknown> | undefined, enabled: boolean, restricted: boolean): IInstantGrepRequest {
	const record = args ?? {};
	const pathValue = record.path ?? record.paths;
	const paths = typeof pathValue === 'string'
		? [pathValue]
		: Array.isArray(pathValue) ? pathValue.filter((entry): entry is string => typeof entry === 'string') : undefined;
	return {
		kind,
		roots,
		paths,
		pattern: typeof record.pattern === 'string' ? record.pattern : '',
		glob: typeof record.glob === 'string' ? record.glob : undefined,
		caseInsensitive: record['-i'] === true || record.caseInsensitive === true,
		enabled,
		restricted,
	};
}

let sharedHost: InstantGrepHost | undefined;

export function getSharedInstantGrepHost(): InstantGrepHost {
	if (!sharedHost) {
		sharedHost = new InstantGrepHost();
	}
	return sharedHost;
}

/**
 * One grep implementation. Copilot, Claude, and Codex all call this.
 * A query does not reset and does not write a commit directory.
 */
export async function dispatchInstantGrep(host: InstantGrepHost, request: IInstantGrepRequest): Promise<IInstantGrepResult> {
	const roots = request.roots.map(root => resolve(root)).filter(root => root.length > 0);
	if (roots.length === 0 || !request.pattern) {
		return { text: emptyText(request.kind), source: 'scan', generation: 0 };
	}
	const scopes = resolveScopes(roots, request.paths);
	const parts: IInstantGrepResult[] = [];
	for (const scope of scopes) {
		parts.push(await searchScope(host, request, scope.root, scope.scope));
	}
	return parts.length === 1 ? parts[0] : mergeResults(request.kind, parts);
}

export class InstantGrepHost {
	private readonly _hash: (gram: string) => bigint;
	private readonly _states = new Map<string, IRepoState>();
	private readonly _clients = new Map<string, GrepClient>();
	private readonly _generation = new Map<string, number>();
	private readonly _watchers = new Map<string, FSWatcher>();

	constructor(private readonly _options: IInstantGrepHostOptions = {}) {
		this._hash = _options.hash ?? fnv1a64;
	}

	/** Loads or rebuilds the cache. Restricted Mode returns without writing. */
	open(root: string, options?: { restricted?: boolean }): void {
		if (options?.restricted) {
			return;
		}
		const gitRoot = findGitRoot(root);
		if (!gitRoot) {
			return;
		}
		this.openRepo(gitRoot);
		for (const rel of listSubmodules(gitRoot)) {
			const child = findGitRoot(join(gitRoot, rel));
			if (child && child !== gitRoot) {
				this.openRepo(child);
			}
		}
	}

	/**
	 * A new Grep client. Reports the two counts and leaves the commit
	 * directory unchanged.
	 */
	resetIndexToHead(root: string): IInstantGrepStatus {
		const gitRoot = findGitRoot(root);
		if (!gitRoot) {
			return { commitDocuments: 0, worktreeDocuments: 0 };
		}
		if (!this._states.has(gitRoot)) {
			return { commitDocuments: 0, worktreeDocuments: 0 };
		}
		this.installClient(gitRoot);
		for (const rel of listSubmodules(gitRoot)) {
			const child = findGitRoot(join(gitRoot, rel));
			if (child && this._states.has(child)) {
				this.installClient(child);
			}
		}
		return this._clients.get(gitRoot)?.status() ?? { commitDocuments: 0, worktreeDocuments: 0 };
	}

	/** The watcher applies a pending edit through tracked state. */
	applyPending(root: string, relativePath: string): void {
		const abs = isAbsolute(relativePath) ? relativePath : join(root, relativePath);
		const gitRoot = findGitRoot(dirname(abs)) ?? findGitRoot(root);
		if (!gitRoot) {
			return;
		}
		const state = this._states.get(gitRoot);
		if (!state) {
			return;
		}
		const rel = relativeTo(gitRoot, abs);
		if (!rel || rel.startsWith('..') || rel === '.git' || rel.startsWith('.git/')) {
			return;
		}
		let isDir = false;
		let exists = false;
		try {
			const stat = statSync(abs);
			exists = true;
			isDir = stat.isDirectory();
		} catch {
			exists = false;
		}
		if (!exists) {
			this.markMissing(state, rel);
			return;
		}
		if (isDir) {
			walkIncluded(abs, (_child, file) => {
				const childRel = relativeTo(gitRoot, file);
				if (childRel && !childRel.startsWith('..')) {
					this.markFile(state, gitRoot, childRel, file);
				}
			}, { ruleRoot: gitRoot });
			return;
		}
		this.markFile(state, gitRoot, rel, abs);
	}

	hasClient(root: string): boolean {
		const gitRoot = findGitRoot(root);
		return !!gitRoot && this._clients.has(gitRoot);
	}

	generation(root: string): number {
		const gitRoot = findGitRoot(root);
		return gitRoot ? this._generation.get(gitRoot) ?? 0 : 0;
	}

	/**
	 * Reads the layer the current client already holds. Does not reset and
	 * does not write a directory. `undefined` means the index cannot answer.
	 */
	searchHeld(root: string, scope: string, request: IInstantGrepRequest): IInstantGrepResult | undefined {
		const gitRoot = findGitRoot(root);
		if (!gitRoot) {
			return undefined;
		}
		if (request.kind === 'grep') {
			// Validate before answering so a bad expression is not an empty index hit.
			new RegExp(request.pattern, request.caseInsensitive ? 'i' : '');
		}
		const scopeGit = findGitRoot(scope);
		const matches: IGrepMatch[] = [];
		const paths: string[] = [];
		let generation = 0;
		const searchRepo = (repo: string, prefix: string, scopeRel: string) => {
			const client = this._clients.get(repo);
			if (!client) {
				return false;
			}
			generation = Math.max(generation, client.generation);
			if (request.kind === 'grep') {
				for (const hit of client.grep(request.pattern, scopeRel, request.glob, request.caseInsensitive === true)) {
					matches.push({ ...hit, path: prefixPath(prefix, hit.path) });
				}
			} else {
				for (const path of client.glob(request.pattern, scopeRel)) {
					paths.push(prefixPath(prefix, path));
				}
			}
			return true;
		};

		if (scopeGit && scopeGit !== gitRoot && isSubmodule(gitRoot, scopeGit)) {
			const scopeRel = relativeTo(scopeGit, scope);
			if (!searchRepo(scopeGit, relativeTo(gitRoot, scopeGit), scopeRel)) {
				return undefined;
			}
		} else {
			const scopeRel = relativeTo(gitRoot, scope);
			if (!searchRepo(gitRoot, '', scopeRel.startsWith('..') ? '' : scopeRel)) {
				return undefined;
			}
			for (const rel of listSubmodules(gitRoot)) {
				const child = findGitRoot(join(gitRoot, rel));
				if (!child || !this._clients.has(child)) {
					continue;
				}
				const childInsideScope = scopeRel === '' || rel === scopeRel || rel.startsWith(`${scopeRel}/`);
				const scopeInsideChild = scopeRel === rel || scopeRel.startsWith(`${rel}/`);
				if (!childInsideScope && !scopeInsideChild) {
					continue;
				}
				const childScope = scopeInsideChild && scopeRel !== rel ? scopeRel.slice(rel.length + 1) : '';
				searchRepo(child, rel, childScope);
			}
		}
		const text = request.kind === 'grep' ? formatMatches(matches) : formatPaths(paths);
		return { text, source: 'index', generation };
	}

	dispose(): void {
		for (const watcher of this._watchers.values()) {
			watcher.close();
		}
		this._watchers.clear();
		for (const client of this._clients.values()) {
			client.dispose();
		}
		this._clients.clear();
	}

	private openRepo(repo: string): void {
		if (this._options.failBuild) {
			throw new Error('indexer crashed');
		}
		const head = gitHead(repo);
		if (!head) {
			return;
		}
		const loaded = this._states.get(repo);
		if (loaded && existsSync(join(loaded.indexDir, 'index.bin'))) {
			if (loaded.sha === head || !driftedFrom(repo, loaded.sha, head)) {
				this.ensureWatch(repo);
				return;
			}
		}
		const sha = this.resolveSha(repo, head);
		if (loaded?.sha === sha && existsSync(join(loaded.indexDir, 'index.bin'))) {
			this.ensureWatch(repo);
			return;
		}
		this._states.set(repo, this.captureState(repo, sha));
		this._clients.get(repo)?.dispose();
		this._clients.delete(repo);
		this.ensureWatch(repo);
	}

	private resolveSha(repo: string, head: string): string {
		const cache = cacheDirectory(repo);
		let names: string[] = [];
		try {
			names = readdirSync(cache).filter(name => /^[0-9a-f]{40}$/.test(name) && existsSync(join(cache, name, 'metadata.json')));
		} catch {
			names = [];
		}
		const cached = chooseCachedSha(names, repo, head);
		if (cached && !driftedFrom(repo, cached, head)) {
			return cached;
		}
		this.build(repo, head);
		return head;
	}

	private build(repo: string, sha: string): void {
		const cache = cacheDirectory(repo);
		mkdirSync(cache, { recursive: true });
		const lockPath = join(cache, 'build.lock');
		const fd = lockBuild(lockPath);
		const staging = join(cache, `${sha}.building`);
		try {
			rmSync(staging, { recursive: true, force: true });
			mkdirSync(staging, { recursive: true });
			writeIndex(staging, sha, documentsFor(repo, sha), this._hash);
			const finalDir = join(cache, sha);
			rmSync(finalDir, { recursive: true, force: true });
			renameSync(staging, finalDir);
		} catch (error) {
			rmSync(staging, { recursive: true, force: true });
			throw error;
		} finally {
			closeSync(fd);
			try {
				unlinkSync(lockPath);
			} catch {
				// The lock is already gone.
			}
		}
	}

	private captureState(repo: string, sha: string): IRepoState {
		const indexDir = join(cacheDirectory(repo), sha);
		const mapped = mapIndex(indexDir);
		if (!mapped) {
			throw new Error('index unreadable');
		}
		const baseline = new Set(mapped.paths);
		mapped.dispose();
		return { sha, indexDir, baseline, layer: captureLayer(repo, sha, baseline) };
	}

	private installClient(repo: string): void {
		const state = this._states.get(repo);
		if (!state) {
			return;
		}
		const mapped = mapIndex(state.indexDir);
		if (!mapped) {
			throw new Error('index unreadable');
		}
		const generation = (this._generation.get(repo) ?? 0) + 1;
		this._generation.set(repo, generation);
		const client = new GrepClient(repo, state.sha, mapped, new Set(state.baseline), new Map(state.layer), this._hash, generation);
		this._clients.get(repo)?.dispose();
		this._clients.set(repo, client);
	}

	private ensureWatch(repo: string): void {
		if (this._options.watch === false || this._watchers.has(repo)) {
			return;
		}
		try {
			const watcher = watch(repo, { recursive: true }, (_event, filename) => {
				if (!filename) {
					return;
				}
				const rel = String(filename).split(sep).join('/');
				if (rel === '.git' || rel.startsWith('.git/') || rel.includes('/.git/')) {
					return;
				}
				this.applyPending(repo, rel);
			});
			this._watchers.set(repo, watcher);
		} catch {
			// The checkout is still searchable without a watcher.
		}
	}

	private markMissing(state: IRepoState, rel: string): void {
		if (state.baseline.has(rel)) {
			state.layer.set(rel, DELETED);
		} else {
			state.layer.delete(rel);
		}
	}

	private markFile(state: IRepoState, repo: string, rel: string, abs: string): void {
		if (loadIgnore(repo).ignores(rel, false)) {
			this.markMissing(state, rel);
			return;
		}
		const read = readWorktreeText(abs);
		if (!read) {
			this.markMissing(state, rel);
			return;
		}
		state.layer.set(rel, {
			kind: state.baseline.has(rel) ? 'modify' : 'add',
			text: read.text,
			mustScan: read.mustScan,
		});
	}
}

class GrepClient {
	constructor(
		private readonly repo: string,
		private readonly sha: string,
		private readonly index: IMappedIndex,
		private readonly baseline: ReadonlySet<string>,
		private readonly layer: ReadonlyMap<string, ILayerEntry>,
		private readonly hash: (gram: string) => bigint,
		readonly generation: number,
	) { }

	status(): IInstantGrepStatus {
		let worktreeDocuments = 0;
		for (const entry of this.layer.values()) {
			if (entry.kind !== 'delete') {
				worktreeDocuments++;
			}
		}
		return { commitDocuments: this.baseline.size, worktreeDocuments };
	}

	grep(pattern: string, scopeRel: string, glob: string | undefined, caseInsensitive: boolean): IGrepMatch[] {
		const regex = new RegExp(pattern, caseInsensitive ? 'i' : '');
		const globMatcher = glob ? parse(glob) : undefined;
		const matches: IGrepMatch[] = [];
		for (const path of this.candidatePaths(pattern, caseInsensitive)) {
			if (!inScope(path, scopeRel)) {
				continue;
			}
			if (globMatcher && !(globMatcher(path) || globMatcher(path.split('/').pop() ?? path))) {
				continue;
			}
			const text = this.text(path);
			if (text === undefined) {
				continue;
			}
			for (const hit of matchLines(text, regex)) {
				matches.push({ path, line: hit.line, text: hit.text });
			}
		}
		return matches;
	}

	glob(pattern: string, scopeRel: string): string[] {
		const matcher = parse(pattern);
		const paths: string[] = [];
		for (const path of this.visiblePaths()) {
			if (!inScope(path, scopeRel)) {
				continue;
			}
			if (matcher(path) || matcher(path.split('/').pop() ?? path)) {
				paths.push(path);
			}
		}
		return paths;
	}

	dispose(): void {
		this.index.dispose();
	}

	private candidatePaths(pattern: string, caseInsensitive: boolean): Set<string> {
		const everything = this.visiblePaths();
		if (caseInsensitive) {
			return everything;
		}
		const groups = literalGroups(pattern);
		if (!groups) {
			return this.withExtras(everything);
		}
		const union = new Set<string>();
		for (const group of groups) {
			let inter: Set<string> | undefined;
			let selective = false;
			for (const literal of group) {
				const set = this.pathsForLiteral(literal);
				if (!set) {
					continue;
				}
				selective = true;
				inter = inter ? new Set([...inter].filter(path => set.has(path))) : new Set(set);
			}
			const branch = selective && inter ? inter : everything;
			for (const path of branch) {
				union.add(path);
			}
		}
		return this.withExtras(union);
	}

	private pathsForLiteral(literal: string): Set<string> | undefined {
		const grams = buildCovering(literal);
		if (grams.length === 0) {
			return undefined;
		}
		let acc: Set<number> | undefined;
		for (const gram of grams) {
			const ids = new Set(this.index.lookup(this.hash(gram.text)));
			if (!acc) {
				acc = ids;
			} else {
				for (const id of acc) {
					if (!ids.has(id)) {
						acc.delete(id);
					}
				}
			}
		}
		const paths = new Set<string>();
		for (const id of acc ?? []) {
			const path = this.index.paths[id];
			if (path) {
				paths.add(path);
			}
		}
		return paths;
	}

	private withExtras(paths: Set<string>): Set<string> {
		for (const id of this.index.mustScan) {
			const path = this.index.paths[id];
			if (path && !this.isDeleted(path)) {
				paths.add(path);
			}
		}
		for (const [path, entry] of this.layer) {
			if (entry.kind === 'delete') {
				paths.delete(path);
			} else {
				paths.add(path);
			}
		}
		return paths;
	}

	private visiblePaths(): Set<string> {
		const paths = new Set<string>(this.baseline);
		for (const [path, entry] of this.layer) {
			if (entry.kind === 'delete') {
				paths.delete(path);
			} else {
				paths.add(path);
			}
		}
		return paths;
	}

	private isDeleted(path: string): boolean {
		return this.layer.get(path)?.kind === 'delete';
	}

	private text(path: string): string | undefined {
		const entry = this.layer.get(path);
		if (entry?.kind === 'delete') {
			return undefined;
		}
		if (entry) {
			return entry.text;
		}
		if (!this.baseline.has(path)) {
			return undefined;
		}
		const bytes = readCommitFile(this.repo, this.sha, path);
		return bytes ? bytes.toString('utf8') : undefined;
	}
}

function documentsFor(repo: string, sha: string): IIndexDocument[] {
	const ignore = loadIgnore(repo);
	const docs: IIndexDocument[] = [];
	for (const path of listCommitFiles(repo, sha)) {
		if (ignore.ignores(path, false)) {
			continue;
		}
		const bytes = readCommitFile(repo, sha, path);
		if (!bytes) {
			continue;
		}
		docs.push(toDocument(path, bytes));
	}
	return docs;
}

function toDocument(path: string, bytes: Buffer): IIndexDocument {
	if (bytes.includes(0) || bytes.length > MAX_NGRAM_BYTES) {
		return { path, grams: [], mustScan: true };
	}
	return { path, grams: buildAll(bytes.toString('utf8')).map(gram => gram.text), mustScan: false };
}

function captureLayer(repo: string, sha: string, baseline: ReadonlySet<string>): Map<string, ILayerEntry> {
	const layer = new Map<string, ILayerEntry>();
	const ignore = loadIgnore(repo);
	for (const change of diffNameStatus(repo, sha)) {
		if (change.oldPath) {
			layer.set(change.oldPath, DELETED);
		}
		if (change.status === 'D' || !existsSync(join(repo, change.path)) || ignore.ignores(change.path, false)) {
			layer.set(change.path, DELETED);
			continue;
		}
		const read = readWorktreeText(join(repo, change.path));
		if (!read) {
			continue;
		}
		layer.set(change.path, {
			kind: baseline.has(change.path) ? 'modify' : 'add',
			text: read.text,
			mustScan: read.mustScan,
		});
	}
	walkIncluded(repo, (rel, abs) => {
		if (baseline.has(rel) || layer.has(rel)) {
			return;
		}
		const read = readWorktreeText(abs);
		if (!read) {
			return;
		}
		layer.set(rel, { kind: 'add', text: read.text, mustScan: read.mustScan });
	});
	return layer;
}

function readWorktreeText(abs: string): { text: string; mustScan: boolean } | undefined {
	try {
		const bytes = readFileSync(abs);
		return { text: bytes.toString('utf8'), mustScan: bytes.includes(0) || bytes.length > MAX_NGRAM_BYTES };
	} catch {
		return undefined;
	}
}

function lockBuild(lockPath: string): number {
	for (let attempt = 0; attempt < 50; attempt++) {
		try {
			return openSync(lockPath, 'wx');
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== 'EEXIST') {
				throw error;
			}
			pause(20);
		}
	}
	throw new Error('index build lock');
}

function pause(ms: number): void {
	try {
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
	} catch {
		const end = Date.now() + ms;
		while (Date.now() < end) {
			// The lock holder is another builder in this process.
		}
	}
}

async function searchScope(host: InstantGrepHost, request: IInstantGrepRequest, root: string, scope: string): Promise<IInstantGrepResult> {
	const gitRoot = findGitRoot(root);
	const scopeGit = findGitRoot(scope);
	const fallback = () => scanned(request, root, scope, gitRoot);
	if (!request.enabled || request.restricted || !gitRoot) {
		return fallback();
	}
	if (scopeGit && scopeGit !== gitRoot && !isSubmodule(gitRoot, scopeGit)) {
		return scanned(request, root, scope, scopeGit);
	}
	try {
		host.open(root);
		if (!host.hasClient(gitRoot)) {
			host.resetIndexToHead(root);
		}
		const indexed = host.searchHeld(root, scope, request);
		if (!indexed) {
			return fallback();
		}
		return indexed;
	} catch (error) {
		if (isRegexError(error)) {
			return { text: `Invalid regular expression: ${errorText(error)}`, source: 'index', generation: host.generation(gitRoot) };
		}
		return fallback();
	}
}

function scanned(request: IInstantGrepRequest, reportRoot: string, scope: string, ignoreRoot: string | undefined): IInstantGrepResult {
	let text: string;
	try {
		const found = directScan({
			kind: request.kind,
			reportRoot,
			ignoreRoot: ignoreRoot ?? reportRoot,
			scope,
			pattern: request.pattern,
			glob: request.glob,
			caseInsensitive: request.caseInsensitive,
		});
		text = request.kind === 'grep' ? formatMatches(found.matches) : formatPaths(found.paths);
	} catch (error) {
		text = isRegexError(error) ? `Invalid regular expression: ${errorText(error)}` : errorText(error);
	}
	return { text, source: 'scan', generation: 0 };
}

function resolveScopes(roots: readonly string[], paths: readonly string[] | undefined): { root: string; scope: string }[] {
	if (!paths || paths.length === 0) {
		return roots.map(root => ({ root, scope: root }));
	}
	return paths.map(path => {
		const abs = isAbsolute(path) ? resolve(path) : resolve(roots[0], path);
		const root = roots.find(candidate => abs === candidate || abs.startsWith(candidate + sep)) ?? roots[0];
		return { root, scope: abs };
	});
}

function mergeResults(kind: 'grep' | 'glob', parts: readonly IInstantGrepResult[]): IInstantGrepResult {
	const empty = emptyText(kind);
	const bodies = parts.map(part => part.text.replace(/\nResults truncated\.$/, '')).filter(text => text !== empty && text.length > 0);
	const source = parts.every(part => part.source === 'index') ? 'index' : 'scan';
	const generation = parts.reduce((max, part) => Math.max(max, part.generation), 0);
	if (bodies.length === 0) {
		return { text: empty, source, generation };
	}
	return { text: bodies.join('\n'), source, generation };
}

function formatMatches(matches: readonly IGrepMatch[]): string {
	const ordered = [...matches].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
	const limited = ordered.slice(0, MAX_RESULTS);
	const body = limited.map(match => `${match.path}:${match.line}:${match.text}`).join('\n');
	return (body || 'No matches found.') + (ordered.length > MAX_RESULTS ? '\nResults truncated.' : '');
}

function formatPaths(paths: readonly string[]): string {
	const unique = [...new Set(paths)].sort();
	const limited = unique.slice(0, MAX_RESULTS);
	return (limited.join('\n') || 'No files found.') + (unique.length > MAX_RESULTS ? '\nResults truncated.' : '');
}

function emptyText(kind: 'grep' | 'glob'): string {
	return kind === 'glob' ? 'No files found.' : 'No matches found.';
}

function prefixPath(prefix: string, path: string): string {
	if (!prefix || prefix === '.') {
		return path;
	}
	return path ? `${prefix}/${path}` : prefix;
}

function inScope(path: string, scopeRel: string): boolean {
	if (!scopeRel || scopeRel === '.') {
		return true;
	}
	const prefix = scopeRel.replace(/\/$/, '');
	return path === prefix || path.startsWith(`${prefix}/`);
}

function isRegexError(error: unknown): boolean {
	return error instanceof SyntaxError;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
