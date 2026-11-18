/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NexusIDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChatAIDisabledSettingId } from '../../../../platform/chat/common/chatSettings.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';

/**
 * Default setting values that NexusIDE changes from upstream Code-OSS.
 *
 * `chat.disableAIFeatures` is turned on so the built-in GitHub Copilot chat, sign-in,
 * inline suggestions and walkthrough steps are hidden. The NexusIDE chat panel does not
 * read this setting. A user can still set it to `false` in Settings to bring Copilot back.
 */
export const NEXUS_CHAT_CONFIGURATION_DEFAULTS: Readonly<Record<string, unknown>> = {
	[ChatAIDisabledSettingId]: true,
};

export const NEXUS_CHAT_CONFIGURATION_DEFAULTS_SOURCE = 'NexusIDE';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerDefaultConfigurations([{
	overrides: { ...NEXUS_CHAT_CONFIGURATION_DEFAULTS },
	source: NEXUS_CHAT_CONFIGURATION_DEFAULTS_SOURCE,
}]);
