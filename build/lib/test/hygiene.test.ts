/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { suite, test } from 'node:test';
import { checkExtensionsGallery } from '../../hygiene.ts';

suite('hygiene', () => {

	test('rejects requested files that enter no hygiene checker', () => {
		const repositoryRoot = path.join(import.meta.dirname, '../../..');
		const result = spawnSync(process.execPath, [
			'--experimental-strip-types',
			'build/hygiene.ts',
			'src/vs/editor/contrib/colorPicker/browser/images/opacity-background.png',
		], {
			cwd: repositoryRoot,
			encoding: 'utf8',
		});

		assert.deepStrictEqual({
			status: result.status,
			hasNoMatchError: result.stderr.includes('No hygiene-eligible files matched the requested paths'),
		}, {
			status: 1,
			hasNoMatchError: true,
		});
	});

	suite('extensionsGallery in product.json', () => {

		const openVsx = {
			serviceUrl: 'https://open-vsx.org/vscode/gallery',
			itemUrl: 'https://open-vsx.org/vscode/item',
			resourceUrlTemplate: 'https://open-vsx.org/vscode/unpkg/{publisher}/{name}/{version}/{path}',
			extensionUrlTemplate: 'https://open-vsx.org/vscode/gallery/{publisher}/{name}/latest',
		};

		test('allows a missing entry and an Open VSX entry', () => {
			assert.strictEqual(checkExtensionsGallery(undefined), undefined);
			assert.strictEqual(checkExtensionsGallery(openVsx), undefined);
		});

		test('allows the entry in the repository product.json', () => {
			const product = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '../../../product.json'), 'utf8'));
			assert.ok(product.extensionsGallery, 'product.json configures a marketplace');
			assert.strictEqual(checkExtensionsGallery(product.extensionsGallery), undefined);
		});

		test('rejects any other marketplace host', () => {
			for (const serviceUrl of [
				'https://marketplace.visualstudio.com/_apis/public/gallery',
				'https://open-vsx.org.example.com/vscode/gallery',
				'https://example.com/open-vsx.org/vscode/gallery',
				'https://evil.open-vsx.org/vscode/gallery',
			]) {
				assert.ok(checkExtensionsGallery({ ...openVsx, serviceUrl })?.includes('extensionsGallery.serviceUrl'), serviceUrl);
			}
		});

		test('rejects plain http, a port, credentials and values that are not URLs', () => {
			for (const itemUrl of [
				'http://open-vsx.org/vscode/item',
				'https://open-vsx.org:8443/vscode/item',
				'https://user:pass@open-vsx.org/vscode/item',
				'open-vsx.org/vscode/item',
			]) {
				assert.ok(checkExtensionsGallery({ ...openVsx, itemUrl })?.includes('extensionsGallery.itemUrl'), itemUrl);
			}
			assert.ok(checkExtensionsGallery({ ...openVsx, itemUrl: 42 })?.includes('extensionsGallery.itemUrl'));
		});

		test('rejects an entry that is not an object', () => {
			for (const gallery of [null, 'https://open-vsx.org/vscode/gallery', ['https://open-vsx.org/vscode/gallery']]) {
				assert.ok(checkExtensionsGallery(gallery), JSON.stringify(gallery));
			}
		});
	});
});
