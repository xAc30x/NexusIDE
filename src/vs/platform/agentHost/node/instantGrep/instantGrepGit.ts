/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path';

const DRIFT_COMMITS = 50;
const DRIFT_PATHS = 200;

export function git(repo: string, args: readonly string[]): string {
	return execFileSync('git', ['-c', 'safe.directory=*', ...args], {
		cwd: repo,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
		maxBuffer: 32 * 1024 * 1024,
	}).trim();
}

function gitBuffer(repo: string, args: readonly string[]): Buffer {
	return execFileSync('git', ['-c', 'safe.directory=*', ...args], {
		cwd: repo,
		stdio: ['ignore', 'pipe', 'pipe'],
		maxBuffer: 64 * 1024 * 1024,
	});
}

export function findGitRoot(start: string): string | undefined {
	let dir = resolve(start);
	try {
		const stat = existsSync(dir);
		if (!stat) {
			dir = dirname(dir);
		}
	} catch {
		return undefined;
	}
	while (!existsSync(dir)) {
		const parent = dirname(dir);
		if (parent === dir) {
			return undefined;
		}
		dir = parent;
	}
	try {
		const top = git(dir, ['rev-parse', '--show-toplevel']);
		return top || undefined;
	} catch {
		return undefined;
	}
}

export function gitHead(repo: string): string | undefined {
	try {
		const sha = git(repo, ['rev-parse', 'HEAD']).toLowerCase();
		return /^[0-9a-f]{40}$/.test(sha) ? sha : undefined;
	} catch {
		return undefined;
	}
}

/** `git rev-parse --git-common-dir`, resolved against the checkout. */
export function gitCommonDir(repo: string): string {
	const out = git(repo, ['rev-parse', '--git-common-dir']);
	return isAbsolute(out) ? out : resolve(repo, out);
}

export function cacheDirectory(repo: string): string {
	return join(gitCommonDir(repo), 'nexus', 'crepe');
}

export function listCommitFiles(repo: string, sha: string): string[] {
	try {
		const buf = gitBuffer(repo, ['ls-tree', '-r', '-z', '--name-only', sha]);
		return buf.toString('utf8').split('\0').filter(Boolean);
	} catch {
		return [];
	}
}

export function readCommitFile(repo: string, sha: string, file: string): Buffer | undefined {
	try {
		return gitBuffer(repo, ['cat-file', 'blob', `${sha}:${file}`]);
	} catch {
		return undefined;
	}
}

export interface INameStatus {
	readonly status: string;
	readonly path: string;
	readonly oldPath?: string;
}

export function diffNameStatus(repo: string, sha: string): INameStatus[] {
	let buf: Buffer;
	try {
		buf = gitBuffer(repo, ['diff', '--name-status', '-z', sha]);
	} catch {
		return [];
	}
	const parts = buf.toString('utf8').split('\0').filter(part => part.length > 0);
	const changes: INameStatus[] = [];
	for (let i = 0; i < parts.length;) {
		const status = parts[i++];
		if (!status) {
			break;
		}
		if (status.startsWith('R') || status.startsWith('C')) {
			const oldPath = parts[i++];
			const path = parts[i++];
			if (oldPath && path) {
				changes.push({ status: status[0], path, oldPath });
			}
		} else {
			const path = parts[i++];
			if (path) {
				changes.push({ status: status[0], path });
			}
		}
	}
	return changes;
}

export function listSubmodules(repo: string): string[] {
	const paths = new Set<string>();
	const gitmodules = join(repo, '.gitmodules');
	if (existsSync(gitmodules)) {
		for (const line of readFileSync(gitmodules, 'utf8').split('\n')) {
			const match = line.match(/^\s*path\s*=\s*(.+?)\s*$/);
			if (match) {
				paths.add(match[1].replace(/\\/g, '/'));
			}
		}
	}
	try {
		const buf = gitBuffer(repo, ['ls-tree', '-r', '-z', 'HEAD']);
		for (const line of buf.toString('utf8').split('\0')) {
			if (!line.startsWith('160000 ')) {
				continue;
			}
			const tab = line.indexOf('\t');
			if (tab !== -1) {
				paths.add(line.slice(tab + 1).replace(/\\/g, '/'));
			}
		}
	} catch {
		// No commit yet.
	}
	return [...paths];
}

export function isSubmodule(parent: string, child: string): boolean {
	const rel = relative(parent, child).split(sep).join('/');
	if (!rel || rel.startsWith('..')) {
		return false;
	}
	return listSubmodules(parent).includes(rel);
}

export function driftedFrom(repo: string, indexed: string, head: string): boolean {
	if (indexed === head) {
		return false;
	}
	let base: string;
	try {
		base = git(repo, ['merge-base', indexed, head]).toLowerCase();
	} catch {
		return true;
	}
	if (base !== indexed) {
		return true;
	}
	try {
		const commits = Number(git(repo, ['rev-list', '--count', `${indexed}..${head}`]));
		const names = git(repo, ['diff', '--name-only', '-z', indexed, head]);
		const files = names ? names.split('\0').filter(Boolean).length : 0;
		return commits >= DRIFT_COMMITS || files >= DRIFT_PATHS;
	} catch {
		return true;
	}
}

export function chooseCachedSha(names: readonly string[], repo: string, head: string): string | undefined {
	if (names.includes(head)) {
		return head;
	}
	let best: string | undefined;
	let bestCount = Number.POSITIVE_INFINITY;
	for (const sha of names) {
		if (!/^[0-9a-f]{40}$/.test(sha)) {
			continue;
		}
		try {
			if (git(repo, ['merge-base', sha, head]).toLowerCase() !== sha) {
				continue;
			}
			const count = Number(git(repo, ['rev-list', '--count', `${sha}..${head}`]));
			if (count < bestCount) {
				best = sha;
				bestCount = count;
			}
		} catch {
			// Not an ancestor the client can prefer.
		}
	}
	return best ?? names.find(name => /^[0-9a-f]{40}$/.test(name));
}
