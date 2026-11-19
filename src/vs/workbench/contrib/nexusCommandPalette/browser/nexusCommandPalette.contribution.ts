/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NexusIDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { isFirefox } from '../../../../base/common/platform.js';
import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { INexusCommandPaletteService, NexusCommandPalette } from './nexusCommandPalette.js';

registerSingleton(INexusCommandPaletteService, NexusCommandPalette, InstantiationType.Delayed);

registerAction2(class ShowNexusCommandPaletteAction extends Action2 {
	constructor() {
		super({
			id: 'nexusCommandPalette.show',
			title: localize2('nexusCommandPalette.show', 'Search Chats, Files, and Actions'),
			category: localize2('nexusCommandPalette.category', 'NexusIDE'),
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib + 10,
				when: undefined,
				primary: !isFirefox ? (KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyP) : undefined,
				secondary: [KeyCode.F1],
			},
		});
	}

	run(accessor: ServicesAccessor): void {
		accessor.get(INexusCommandPaletteService).show();
	}
});
