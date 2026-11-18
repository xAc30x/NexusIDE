/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NexusIDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ChatAIDisabledSettingId } from '../../../../../platform/chat/common/chatSettings.js';
import { Extensions as ConfigurationExtensions, IConfigurationNode, IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { NEXUS_CHAT_CONFIGURATION_DEFAULTS_SOURCE } from '../../common/nexusChatConfiguration.js';

suite('NexusChatConfiguration', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const registry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);

	test('turns on chat.disableAIFeatures by default, credited to NexusIDE', () => {
		const override = registry.getConfigurationDefaultsOverrides().get(ChatAIDisabledSettingId);
		assert.deepStrictEqual(
			{ value: override?.value, source: override?.source },
			{ value: true, source: NEXUS_CHAT_CONFIGURATION_DEFAULTS_SOURCE },
		);
	});

	test('the default still applies when the setting is registered after NexusIDE loads', () => {
		// Upstream registers the setting with default false in chat.shared.contribution.ts,
		// which can load after the NexusIDE module. Register a stand-in the same way.
		const node: IConfigurationNode = {
			id: 'nexusChatConfigurationTest',
			properties: { [ChatAIDisabledSettingId]: { type: 'boolean', default: false } },
		};
		const alreadyRegistered = registry.getConfigurationProperties()[ChatAIDisabledSettingId] !== undefined;
		if (!alreadyRegistered) {
			registry.registerConfiguration(node);
		}
		try {
			assert.strictEqual(registry.getConfigurationProperties()[ChatAIDisabledSettingId].default, true);
		} finally {
			if (!alreadyRegistered) {
				registry.deregisterConfigurations([node]);
			}
		}
	});
});
