/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NexusIDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import product from '../../../../../platform/product/common/product.js';
import { startEntries, walkthroughs } from '../../common/gettingStartedContent.js';

/** Every piece of text in the built-in Welcome page content that a person can see or hear. */
function visibleTexts(): { where: string; text: string }[] {
	const texts: { where: string; text: string }[] = [];
	for (const entry of startEntries) {
		texts.push({ where: `${entry.id}.title`, text: entry.title });
		texts.push({ where: `${entry.id}.description`, text: entry.description });
	}
	for (const walkthrough of walkthroughs) {
		texts.push({ where: `${walkthrough.id}.title`, text: walkthrough.title });
		texts.push({ where: `${walkthrough.id}.description`, text: walkthrough.description });
		texts.push({ where: `${walkthrough.id}.walkthroughPageTitle`, text: walkthrough.walkthroughPageTitle });
		for (const step of walkthrough.content.steps) {
			texts.push({ where: `${walkthrough.id}/${step.id}.title`, text: step.title });
			texts.push({ where: `${walkthrough.id}/${step.id}.description`, text: step.description });
			if (step.media.type !== 'markdown') {
				texts.push({ where: `${walkthrough.id}/${step.id}.altText`, text: step.media.altText });
			}
		}
	}
	return texts;
}

suite('Getting started content branding', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('no Welcome page text names VS Code', () => {
		const offenders = visibleTexts().filter(({ text }) => text.includes('VS Code')).map(({ where }) => where);
		assert.deepStrictEqual(offenders, []);
	});

	test('setup walkthrough is titled with the product name', () => {
		const setup = walkthroughs.find(walkthrough => walkthrough.id === 'Setup');
		assert.ok(setup, 'Setup walkthrough is missing');
		assert.strictEqual(setup.title, `Get started with ${product.nameShort}`);
		assert.strictEqual(setup.walkthroughPageTitle, `Setup ${product.nameShort}`);
	});

	test('product name fills in text that already had a button placeholder', () => {
		const beginner = walkthroughs.find(walkthrough => walkthrough.id === 'Beginner');
		const extensions = beginner?.content.steps.find(step => step.id === 'extensions');
		assert.ok(extensions, 'Beginner/extensions step is missing');
		assert.ok(extensions.description.startsWith(`Extensions are ${product.nameShort}'s power-ups.`), extensions.description);
		assert.ok(!/\{\d\}/.test(extensions.description), 'description still contains an unfilled placeholder');
	});
});
