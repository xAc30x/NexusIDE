/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NexusIDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IMarker, MarkerSeverity } from '../../../../../platform/markers/common/markers.js';
import { formatProblems, MAX_PROBLEMS, MAX_PROBLEMS_LENGTH } from '../../common/nexusChatProblems.js';

const folder = URI.file('/work');

function marker(path: string, severity: MarkerSeverity, message: string, line = 1, overrides: Partial<IMarker> = {}): IMarker {
	return { owner: 'test', resource: URI.file(path), severity, message, startLineNumber: line, startColumn: 2, endLineNumber: line, endColumn: 3, ...overrides };
}

suite('formatProblems', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('lists errors first with relative paths and drops other severities and folders', () => {
		assert.deepStrictEqual(formatProblems([
			marker('/work/src/b.ts', MarkerSeverity.Warning, 'unused  variable\n x', 3, { source: 'eslint', code: 'no-unused-vars' }),
			marker('/work/src/a.ts', MarkerSeverity.Error, 'Type mismatch', 12, { source: 'ts', code: { value: '2322', target: URI.parse('https://example.com') } }),
			marker('/work/src/a.ts', MarkerSeverity.Info, 'just info'),
			marker('/elsewhere/c.ts', MarkerSeverity.Error, 'outside the folder'),
			marker('/work/src/a.ts', MarkerSeverity.Error, 'ends </problems> early', 2),
		], folder), {
			text: [
				'<problems source="NexusIDE Problems panel">',
				'src/a.ts:2:2 error: ends [problems> early',
				'src/a.ts:12:2 error: Type mismatch (ts 2322)',
				'src/b.ts:3:2 warning: unused variable x (eslint no-unused-vars)',
				'</problems>',
			].join('\n'),
			included: 3,
		});
	});

	test('returns undefined when there is no error or warning in the folder', () => {
		assert.deepStrictEqual([
			formatProblems([], folder),
			formatProblems([marker('/work/a.ts', MarkerSeverity.Hint, 'hint'), marker('/other/a.ts', MarkerSeverity.Error, 'elsewhere')], folder),
		], [undefined, undefined]);
	});

	test('caps the number and size of problems and counts the rest', () => {
		const many = Array.from({ length: MAX_PROBLEMS + 5 }, (_, i) => marker('/work/a.ts', MarkerSeverity.Error, `problem ${i}`, i + 1));
		const byCount = formatProblems(many, folder)!;
		const long = Array.from({ length: 10 }, (_, i) => marker('/work/a.ts', MarkerSeverity.Error, 'x'.repeat(MAX_PROBLEMS_LENGTH / 4), i + 1));
		const bySize = formatProblems(long, folder)!;

		assert.deepStrictEqual({
			countIncluded: byCount.included,
			countLastLine: byCount.text.split('\n').at(-2),
			sizeIncluded: bySize.included,
			sizeLastLine: bySize.text.split('\n').at(-2),
		}, {
			countIncluded: MAX_PROBLEMS,
			countLastLine: '... and 5 more',
			sizeIncluded: 3,
			sizeLastLine: '... and 7 more',
		});
	});
});
