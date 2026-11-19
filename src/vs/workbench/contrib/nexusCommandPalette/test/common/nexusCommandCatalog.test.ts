/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NexusIDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ThemeSettingDefaults } from '../../../../services/themes/common/workbenchThemeService.js';
import { NEXUS_COMMAND_PALETTE_PLACEHOLDER, NEXUS_COMMAND_SECTIONS, NexusCommandAction, filterNexusCommandCatalog, formatNexusCommandAge } from '../../common/nexusCommandCatalog.js';

suite('NexusCommandCatalog', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	function labels(): Array<[string, string[]]> {
		return NEXUS_COMMAND_SECTIONS.map(section => [section.label, section.rows.map(row => row.label)]);
	}

	function action(id: string): NexusCommandAction {
		for (const section of NEXUS_COMMAND_SECTIONS) {
			const row = section.rows.find(candidate => candidate.id === id);
			if (row) {
				return row.action;
			}
		}
		assert.fail(`missing row ${id}`);
	}

	test('placeholder and sections match the command palette layout', () => {
		assert.strictEqual(NEXUS_COMMAND_PALETTE_PLACEHOLDER, 'Search chats, files, and actions...');
		assert.deepStrictEqual(labels(), [
			['Chats', []],
			['Agent', ['Go Back', 'Go Forward', 'New Agent', 'Create Project', 'Dictate']],
			['Mode', ['Plan Mode', 'Agent Mode', 'Ask Mode', 'Debug Mode', 'Multitask Mode']],
			['View', ['Hide Minimap', 'Toggle Git Blame', 'Open Customize', 'Open Plugins', 'Open MCPs']],
			['Settings', ['About NexusIDE', 'Report Issue', 'Settings', 'Keyboard Shortcuts', 'Update NexusIDE']],
			['Appearance', ['Light Theme', 'Dark Theme', 'System Theme', 'High Contrast Theme']],
			['Developer', ['Reset In-App Ad Views', 'Reload Window', 'Toggle Developer Tools', 'Developer: Open Logs Folder', 'Developer: Reveal User Data Folder']],
			['Workspace', ['Connect via SSH', 'Connect via WSL', 'Clone Repository', 'Open SSH Configuration File', 'Open Folder']],
			['New Agent with Model', ['Grok 4.7', 'Grok 4.6', 'Claude Opus 5.5', 'Gemini 4 Neon', 'Gemini 4 Carbon']],
			['Customize Sidebar', ['Group by Workspace', 'Group by Repository', 'Group by Updated', 'Group by Status', 'Group by Environment']],
			['Skills', ['agent-sdk-cli', 'agent-sdk-create-agent', 'agent-sdk-debug', 'agent-sdk-deploy', 'agent-sdk-evals']],
			['Settings', ['Tool Call Density', 'Usage Summary', 'Submit with Ctrl + Enter', 'Auto-Approve Mode Transitions', 'Auto-Accept Web Search']],
		]);
	});

	test('wires rows that already have an action and keeps the others inert', () => {
		assert.deepStrictEqual(action('agent.goBack'), { kind: 'command', commandId: 'workbench.action.navigateBack' });
		assert.deepStrictEqual(action('agent.goForward'), { kind: 'command', commandId: 'workbench.action.navigateForward' });
		assert.deepStrictEqual(action('agent.new'), { kind: 'command', commandId: 'nexusChat.newChat' });
		assert.deepStrictEqual(action('agent.dictate'), { kind: 'inert' });
		assert.deepStrictEqual(action('mode.plan'), { kind: 'mode', mode: 'plan' });
		assert.deepStrictEqual(action('mode.agent'), { kind: 'mode', mode: 'agent' });
		assert.deepStrictEqual(action('mode.ask'), { kind: 'mode', mode: 'ask' });
		assert.deepStrictEqual(action('mode.debug'), { kind: 'mode', mode: 'debug' });
		assert.deepStrictEqual(action('mode.multitask'), { kind: 'inert' });
		assert.deepStrictEqual(action('view.minimap'), { kind: 'command', commandId: 'editor.action.toggleMinimap' });
		assert.deepStrictEqual(action('settings.open'), { kind: 'command', commandId: 'workbench.action.openSettings' });
		assert.deepStrictEqual(action('settings.keybindings'), { kind: 'command', commandId: 'workbench.action.openGlobalKeybindings' });
		assert.deepStrictEqual(action('settings.about'), { kind: 'command', commandId: 'workbench.action.showAboutDialog' });
		assert.deepStrictEqual(action('settings.report'), { kind: 'command', commandId: 'workbench.action.openIssueReporter' });
		assert.deepStrictEqual(action('settings.update'), { kind: 'command', commandId: 'update.checkForUpdate' });
		assert.deepStrictEqual(action('appearance.light'), { kind: 'theme', themeId: ThemeSettingDefaults.COLOR_THEME_LIGHT });
		assert.deepStrictEqual(action('appearance.dark'), { kind: 'theme', themeId: ThemeSettingDefaults.COLOR_THEME_DARK });
		assert.deepStrictEqual(action('appearance.highContrast'), { kind: 'theme', themeId: ThemeSettingDefaults.COLOR_THEME_HC_DARK });
		assert.deepStrictEqual(action('appearance.system'), { kind: 'systemTheme' });
		assert.deepStrictEqual(action('developer.reload'), { kind: 'command', commandId: 'workbench.action.reloadWindow' });
		assert.deepStrictEqual(action('developer.tools'), { kind: 'command', commandId: 'workbench.action.toggleDevTools' });
		assert.deepStrictEqual(action('developer.logs'), { kind: 'command', commandId: 'workbench.action.openLogsFolder' });
		assert.deepStrictEqual(action('developer.userData'), { kind: 'command', commandId: 'workbench.action.revealUserDataFolder' });
		assert.deepStrictEqual(action('workspace.clone'), { kind: 'command', commandId: 'git.clone' });
		assert.deepStrictEqual(action('workspace.openFolder'), { kind: 'command', commandId: 'workbench.action.files.openFolder' });
		assert.deepStrictEqual(action('workspace.ssh'), { kind: 'inert' });
		assert.deepStrictEqual(action('models.grok47'), { kind: 'inert' });
		assert.deepStrictEqual(action('skills.cli'), { kind: 'inert' });
		assert.deepStrictEqual(action('toggles.webSearch'), { kind: 'inert' });
	});

	test('filters by tab and query without dropping inert rows', () => {
		assert.deepStrictEqual(filterNexusCommandCatalog(NEXUS_COMMAND_SECTIONS, '', 'chats').map(section => section.id), ['chats']);
		assert.deepStrictEqual(filterNexusCommandCatalog(NEXUS_COMMAND_SECTIONS, 'reload', 'files'), []);
		assert.deepStrictEqual(filterNexusCommandCatalog(NEXUS_COMMAND_SECTIONS, 'reload', 'chats'), []);

		const dictate = filterNexusCommandCatalog(NEXUS_COMMAND_SECTIONS, '  DICTATE ', 'all');
		assert.deepStrictEqual(dictate.map(section => section.rows.map(row => row.label)), [['Dictate']]);
		assert.strictEqual(dictate[0].rows[0].action.kind, 'inert');

		const ssh = filterNexusCommandCatalog(NEXUS_COMMAND_SECTIONS, 'ssh', 'all').flatMap(section => section.rows.map(row => row.label));
		assert.deepStrictEqual(ssh, ['Connect via SSH', 'Open SSH Configuration File']);

		const reload = filterNexusCommandCatalog(NEXUS_COMMAND_SECTIONS, 'Reload', 'all').flatMap(section => section.rows.map(row => row.label));
		assert.deepStrictEqual(reload, ['Reload Window']);

		assert.strictEqual(filterNexusCommandCatalog(NEXUS_COMMAND_SECTIONS, '', 'all').length, NEXUS_COMMAND_SECTIONS.length);
	});

	test('formats a chat age like the palette timestamps', () => {
		const now = 1_700_000_000_000;
		assert.strictEqual(formatNexusCommandAge(now, now), '0s');
		assert.strictEqual(formatNexusCommandAge(now - 30_000, now), '30s');
		assert.strictEqual(formatNexusCommandAge(now - 5 * 60_000, now), '5m');
		assert.strictEqual(formatNexusCommandAge(now - 3 * 60 * 60_000, now), '3h');
		assert.strictEqual(formatNexusCommandAge(now - 7 * 24 * 60 * 60_000, now), '7d');
		assert.strictEqual(formatNexusCommandAge(now - 40 * 24 * 60 * 60_000, now), '1mo');
		assert.strictEqual(formatNexusCommandAge(now - 400 * 24 * 60 * 60_000, now), '1y');
	});
});
