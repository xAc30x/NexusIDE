/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { closeSync, openSync, readFileSync, readSync, writeFileSync } from 'fs';
import { join } from 'path';

/** Nexus postings format. Version 4 is not a byte-compatibility promise. */
export const INSTANT_GREP_VERSION = 4;

const INDEX_MAGIC = Buffer.from('NXG4');
const POSTINGS_MAGIC = Buffer.from('NXP4');
const FLAG_MUST_SCAN = 1;

export interface IIndexDocument {
	readonly path: string;
	readonly grams: readonly string[];
	readonly mustScan: boolean;
}

export interface IMappedIndex {
	readonly version: number;
	readonly paths: readonly string[];
	readonly mustScan: ReadonlySet<number>;
	lookup(hash: bigint): readonly number[];
	dispose(): void;
}

interface IHashEntry {
	readonly hash: bigint;
	readonly offset: number;
}

export function writeIndex(dir: string, sha: string, docs: readonly IIndexDocument[], hashOf: (gram: string) => bigint): void {
	const postings: { hash: bigint; ids: number[] }[] = [];
	const byHash = new Map<bigint, number[]>();
	docs.forEach((doc, id) => {
		const seen = new Set<bigint>();
		for (const gram of doc.grams) {
			const hash = hashOf(gram);
			if (seen.has(hash)) {
				continue;
			}
			seen.add(hash);
			let ids = byHash.get(hash);
			if (!ids) {
				ids = [];
				byHash.set(hash, ids);
			}
			ids.push(id);
		}
	});
	const hashes = [...byHash.keys()].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
	for (const hash of hashes) {
		postings.push({ hash, ids: byHash.get(hash) ?? [] });
	}

	const pathParts: Buffer[] = [];
	for (const doc of docs) {
		const path = Buffer.from(doc.path, 'utf8');
		const header = Buffer.alloc(4 + path.length + 1);
		header.writeUInt32LE(path.length, 0);
		path.copy(header, 4);
		header.writeUInt8(doc.mustScan ? FLAG_MUST_SCAN : 0, 4 + path.length);
		pathParts.push(header);
	}
	const pathTable = Buffer.concat(pathParts);
	const listParts: Buffer[] = [];
	const entries: IHashEntry[] = [];
	let cursor = POSTINGS_MAGIC.length + 8 + pathTable.length;
	for (const posting of postings) {
		entries.push({ hash: posting.hash, offset: cursor });
		const list = Buffer.alloc(4 + posting.ids.length * 4);
		list.writeUInt32LE(posting.ids.length, 0);
		posting.ids.forEach((id, index) => list.writeUInt32LE(id, 4 + index * 4));
		listParts.push(list);
		cursor += list.length;
	}

	const postingsHeader = Buffer.alloc(POSTINGS_MAGIC.length + 8);
	POSTINGS_MAGIC.copy(postingsHeader, 0);
	postingsHeader.writeUInt32LE(INSTANT_GREP_VERSION, 4);
	postingsHeader.writeUInt32LE(docs.length, 8);
	writeFileSync(join(dir, 'postings.bin'), Buffer.concat([postingsHeader, pathTable, ...listParts]));

	const table = Buffer.alloc(INDEX_MAGIC.length + 8 + entries.length * 16);
	INDEX_MAGIC.copy(table, 0);
	table.writeUInt32LE(INSTANT_GREP_VERSION, 4);
	table.writeUInt32LE(entries.length, 8);
	entries.forEach((entry, entryIndex) => {
		const at = 12 + entryIndex * 16;
		table.writeBigUInt64LE(entry.hash, at);
		table.writeBigUInt64LE(BigInt(entry.offset), at + 8);
	});
	writeFileSync(join(dir, 'index.bin'), table);
	writeFileSync(join(dir, 'metadata.json'), JSON.stringify({ version: INSTANT_GREP_VERSION, git_revision: sha }));
}

export function readMetadata(dir: string): { version: number; git_revision: string } | undefined {
	try {
		const parsed = JSON.parse(readFileSync(join(dir, 'metadata.json'), 'utf8')) as { version?: unknown; git_revision?: unknown };
		if (parsed.version !== INSTANT_GREP_VERSION || typeof parsed.git_revision !== 'string') {
			return undefined;
		}
		return { version: INSTANT_GREP_VERSION, git_revision: parsed.git_revision };
	} catch {
		return undefined;
	}
}

/** Reads the hash table from `index.bin`. Posting lists are read by offset; path records are resolved once. */
export function mapIndex(dir: string): IMappedIndex | undefined {
	let fd: number | undefined;
	try {
		const meta = readMetadata(dir);
		if (!meta) {
			return undefined;
		}
		const table = readFileSync(join(dir, 'index.bin'));
		if (table.length < 12 || !table.subarray(0, 4).equals(INDEX_MAGIC) || table.readUInt32LE(4) !== INSTANT_GREP_VERSION) {
			return undefined;
		}
		const count = table.readUInt32LE(8);
		if (table.length < 12 + count * 16) {
			return undefined;
		}
		const entries: IHashEntry[] = new Array(count);
		for (let i = 0; i < count; i++) {
			const at = 12 + i * 16;
			entries[i] = { hash: table.readBigUInt64LE(at), offset: Number(table.readBigUInt64LE(at + 8)) };
		}
		fd = openSync(join(dir, 'postings.bin'), 'r');
		const header = Buffer.alloc(12);
		if (readSync(fd, header, 0, 12, 0) !== 12 || !header.subarray(0, 4).equals(POSTINGS_MAGIC) || header.readUInt32LE(4) !== INSTANT_GREP_VERSION) {
			closeSync(fd);
			return undefined;
		}
		const fileCount = header.readUInt32LE(8);
		const paths: string[] = new Array(fileCount);
		const mustScan = new Set<number>();
		let cursor = 12;
		const lenBuf = Buffer.alloc(4);
		for (let i = 0; i < fileCount; i++) {
			if (readSync(fd, lenBuf, 0, 4, cursor) !== 4) {
				closeSync(fd);
				return undefined;
			}
			const length = lenBuf.readUInt32LE(0);
			const body = Buffer.alloc(length + 1);
			if (readSync(fd, body, 0, body.length, cursor + 4) !== body.length) {
				closeSync(fd);
				return undefined;
			}
			paths[i] = body.subarray(0, length).toString('utf8');
			if (body[length] & FLAG_MUST_SCAN) {
				mustScan.add(i);
			}
			cursor += 4 + body.length;
		}
		const postingsFd = fd;
		fd = undefined;
		return {
			version: INSTANT_GREP_VERSION,
			paths,
			mustScan,
			lookup(hash: bigint): readonly number[] {
				const offset = findOffset(entries, hash);
				if (offset === undefined) {
					return [];
				}
				const countBuf = Buffer.alloc(4);
				if (readSync(postingsFd, countBuf, 0, 4, offset) !== 4) {
					return [];
				}
				const ids = countBuf.readUInt32LE(0);
				if (ids === 0) {
					return [];
				}
				const body = Buffer.alloc(ids * 4);
				if (readSync(postingsFd, body, 0, body.length, offset + 4) !== body.length) {
					return [];
				}
				const out = new Array<number>(ids);
				for (let i = 0; i < ids; i++) {
					out[i] = body.readUInt32LE(i * 4);
				}
				return out;
			},
			dispose(): void {
				try {
					closeSync(postingsFd);
				} catch {
					// Already closed.
				}
			},
		};
	} catch {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				// Already closed.
			}
		}
		return undefined;
	}
}

function findOffset(entries: readonly IHashEntry[], hash: bigint): number | undefined {
	let lo = 0;
	let hi = entries.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const value = entries[mid].hash;
		if (value === hash) {
			return entries[mid].offset;
		}
		if (value < hash) {
			lo = mid + 1;
		} else {
			hi = mid - 1;
		}
	}
	return undefined;
}
