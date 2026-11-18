/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NexusIDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { buildPreviewDocument, getPreviewKind, PREVIEW_CONTENT_SECURITY_POLICY } from '../../browser/nexusChatPreview.js';

suite('NexusChatPreview', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const policy = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CONTENT_SECURITY_POLICY}">`;

	test('recognizes HTML by language or fence label and SVG by fence label', () => {
		assert.deepStrictEqual([
			getPreviewKind('html', 'plaintext'),
			getPreviewKind(undefined, 'html'),
			getPreviewKind('HTM', 'plaintext'),
			getPreviewKind('svg', 'xml'),
			getPreviewKind('xml', 'xml'),
			getPreviewKind('js', 'javascript'),
			getPreviewKind(undefined, 'plaintext'),
		], ['html', 'html', 'html', 'svg', undefined, undefined, undefined]);
	});

	test('puts the content security policy before the page and after a doctype', () => {
		assert.deepStrictEqual([
			buildPreviewDocument('html', '<p>hi</p>'),
			buildPreviewDocument('html', '  <!DOCTYPE html><html><body>x</body></html>'),
			buildPreviewDocument('svg', '<svg></svg>'),
		], [
			`${policy}<p>hi</p>`,
			`  <!DOCTYPE html>${policy}<html><body>x</body></html>`,
			`<!DOCTYPE html><html><head>${policy}<style>body { margin: 0; padding: 8px; }</style></head><body><svg></svg></body></html>`,
		]);
	});

	test('blocks network and file access but lets inline scripts run', () => {
		assert.ok(PREVIEW_CONTENT_SECURITY_POLICY.startsWith(`default-src 'none';`));
		assert.ok(PREVIEW_CONTENT_SECURITY_POLICY.includes(`script-src 'unsafe-inline';`));
		assert.ok(!/https?:|\*/.test(PREVIEW_CONTENT_SECURITY_POLICY), 'no remote sources are allowed');
	});
});
