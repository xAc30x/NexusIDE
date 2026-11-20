/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** How far `buildAll` looks ahead. Indexing and queries share this bound. */
const MAX_WINDOW_PAIRS = 48;

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const FNV_MASK = 0xffffffffffffffffn;

/**
 * Lower weight means a more common pair. The rank is fixed so the same text
 * always yields the same grams.
 */
const COMMON = 'etaoinshrdlucmfwypvbgkqjxz';

export interface ISparseNgram {
	readonly text: string;
	readonly start: number;
	readonly end: number;
}

export function pairWeight(left: number, right: number): number {
	const a = String.fromCharCode(left).toLowerCase();
	const b = String.fromCharCode(right).toLowerCase();
	const ia = COMMON.indexOf(a);
	const ib = COMMON.indexOf(b);
	const rank = (ia === -1 ? 32 : ia) + (ib === -1 ? 32 : ib);
	return rank * 257 + ((left * 131 + right) % 251);
}

/**
 * Shortest sparse n-gram starting at each character-pair index: a substring
 * whose endpoint weights are strictly greater than every interior weight.
 */
export function buildAll(text: string): ISparseNgram[] {
	if (text.length < 4) {
		return [];
	}
	const weights = new Array<number>(text.length - 1);
	for (let i = 0; i < weights.length; i++) {
		weights[i] = pairWeight(text.charCodeAt(i), text.charCodeAt(i + 1));
	}
	const grams: ISparseNgram[] = [];
	for (let left = 0; left < weights.length; left++) {
		let interiorMax = -1;
		const limit = Math.min(weights.length - 1, left + MAX_WINDOW_PAIRS);
		for (let right = left + 2; right <= limit; right++) {
			interiorMax = Math.max(interiorMax, weights[right - 1]);
			if (weights[left] > interiorMax && weights[right] > interiorMax) {
				grams.push({ text: text.slice(left, right + 2), start: left, end: right + 2 });
				break;
			}
		}
	}
	return grams;
}

/** Smallest set of {@link buildAll} grams that cover `literal`. */
export function buildCovering(literal: string): ISparseNgram[] {
	const grams = buildAll(literal);
	if (grams.length === 0) {
		return [];
	}
	const chosen: ISparseNgram[] = [];
	const seen = new Set<string>();
	let cursor = 0;
	while (cursor < literal.length) {
		let best: ISparseNgram | undefined;
		for (const gram of grams) {
			if (gram.start > cursor || gram.end <= cursor) {
				continue;
			}
			if (!best || gram.end > best.end || (gram.end === best.end && rarity(gram) > rarity(best))) {
				best = gram;
			}
		}
		if (!best) {
			let next = literal.length;
			for (const gram of grams) {
				if (gram.start > cursor && gram.start < next) {
					next = gram.start;
				}
			}
			if (next === literal.length) {
				break;
			}
			cursor = next;
			continue;
		}
		if (!seen.has(best.text)) {
			seen.add(best.text);
			chosen.push(best);
		}
		cursor = best.end;
	}
	return chosen;
}

function rarity(gram: ISparseNgram): number {
	if (gram.text.length < 2) {
		return 0;
	}
	const left = pairWeight(gram.text.charCodeAt(0), gram.text.charCodeAt(1));
	const right = pairWeight(gram.text.charCodeAt(gram.text.length - 2), gram.text.charCodeAt(gram.text.length - 1));
	return Math.min(left, right);
}

/**
 * Top-level `|` branches, each a list of literals long enough to cover.
 * `undefined` means the expression is not selective and every document is a candidate.
 */
export function literalGroups(pattern: string): readonly (readonly string[])[] | undefined {
	if (pattern.includes('(?')) {
		return undefined;
	}
	const groups = splitTopLevel(pattern).map(extractLiterals);
	if (groups.some(group => group.length === 0)) {
		return undefined;
	}
	return groups;
}

function extractLiterals(pattern: string): string[] {
	const literals: string[] = [];
	let current = '';
	const flush = () => {
		if (current.length >= 4) {
			literals.push(current);
		}
		current = '';
	};
	for (let i = 0; i < pattern.length; i++) {
		const char = pattern[i];
		if (char === '\\') {
			const next = pattern[i + 1];
			if (next === undefined) {
				flush();
				break;
			}
			if ('ntrdwsDWSbB'.includes(next)) {
				flush();
			} else {
				current += next;
			}
			i++;
			continue;
		}
		if (char === '[') {
			flush();
			const close = pattern.indexOf(']', i + 1);
			i = close === -1 ? pattern.length : close;
			continue;
		}
		if (char === '(') {
			flush();
			continue;
		}
		if ('.)^$*+?{}|'.includes(char)) {
			flush();
			continue;
		}
		current += char;
	}
	flush();
	return literals;
}

function splitTopLevel(pattern: string): string[] {
	const parts: string[] = [];
	let current = '';
	let depth = 0;
	let klass = false;
	for (let i = 0; i < pattern.length; i++) {
		const char = pattern[i];
		if (char === '\\') {
			current += char + (pattern[i + 1] ?? '');
			i++;
			continue;
		}
		if (klass) {
			current += char;
			if (char === ']') {
				klass = false;
			}
			continue;
		}
		if (char === '[') {
			klass = true;
			current += char;
			continue;
		}
		if (char === '(') {
			depth++;
		} else if (char === ')') {
			depth = Math.max(0, depth - 1);
		}
		if (char === '|' && depth === 0) {
			parts.push(current);
			current = '';
			continue;
		}
		current += char;
	}
	parts.push(current);
	return parts;
}

export function fnv1a64(text: string): bigint {
	let hash = FNV_OFFSET;
	const bytes = Buffer.from(text, 'utf8');
	for (const byte of bytes) {
		hash ^= BigInt(byte);
		hash = (hash * FNV_PRIME) & FNV_MASK;
	}
	return hash;
}
