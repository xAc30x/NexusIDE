/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NexusIDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { ThemeSettingDefaults } from '../../../services/themes/common/workbenchThemeService.js';
import { NEXUS_CHAT_NEW_CHAT_COMMAND_ID, NEXUS_CHAT_SET_MODE_COMMAND_ID, NEXUS_CHAT_SHOW_COMMAND_ID } from '../../nexusChat/common/nexusOpenChat.js';
import { AIExecutionMode } from '../../../../platform/ai/common/ai.js';

export const NEXUS_COMMAND_PALETTE_PLACEHOLDER = localize('nexusCommandPalette.placeholder', "Search chats, files, and actions...");

export type NexusCommandPaletteTab = 'all' | 'chats' | 'files';

/**
 * What accepting a row does. `inert` is a row from the Cursor layout that
 * NexusIDE cannot run yet.
 */
export type NexusCommandAction =
	| { readonly kind: 'command'; readonly commandId: string }
	| { readonly kind: 'theme'; readonly themeId: string }
	| { readonly kind: 'systemTheme' }
	| { readonly kind: 'mode'; readonly mode: AIExecutionMode }
	| { readonly kind: 'inert' };

export interface INexusCommandRow {
	readonly id: string;
	readonly label: string;
	readonly icon: ThemeIcon;
	readonly action: NexusCommandAction;
	/** Right-aligned text, used for a chat's age. */
	readonly description?: string;
}

export interface INexusCommandSection {
	readonly id: string;
	readonly label: string;
	readonly rows: readonly INexusCommandRow[];
}

const command = (id: string, label: string, icon: ThemeIcon, commandId: string): INexusCommandRow =>
	({ id, label, icon, action: { kind: 'command', commandId } });

const inert = (id: string, label: string, icon: ThemeIcon): INexusCommandRow =>
	({ id, label, icon, action: { kind: 'inert' } });

const mode = (id: string, label: string, icon: ThemeIcon, value: AIExecutionMode): INexusCommandRow =>
	({ id, label, icon, action: { kind: 'mode', mode: value } });

/**
 * Sections in the order of the Cursor command palette. Chat rows are added
 * by the palette from the open Nexus chat; this section stays empty until then.
 * "About Cursor" and "Update Cursor" use the NexusIDE name.
 */
export const NEXUS_COMMAND_SECTIONS: readonly INexusCommandSection[] = [
	{
		id: 'chats',
		label: localize('nexusCommandPalette.chats', "Chats"),
		rows: [],
	},
	{
		id: 'agent',
		label: localize('nexusCommandPalette.agent', "Agent"),
		rows: [
			command('agent.goBack', localize('nexusCommandPalette.goBack', "Go Back"), Codicon.arrowLeft, 'workbench.action.navigateBack'),
			command('agent.goForward', localize('nexusCommandPalette.goForward', "Go Forward"), Codicon.arrowRight, 'workbench.action.navigateForward'),
			command('agent.new', localize('nexusCommandPalette.newAgent', "New Agent"), Codicon.add, NEXUS_CHAT_NEW_CHAT_COMMAND_ID),
			inert('agent.createProject', localize('nexusCommandPalette.createProject', "Create Project"), Codicon.folder),
			inert('agent.dictate', localize('nexusCommandPalette.dictate', "Dictate"), Codicon.mic),
		],
	},
	{
		id: 'mode',
		label: localize('nexusCommandPalette.mode', "Mode"),
		rows: [
			mode('mode.plan', localize('nexusCommandPalette.planMode', "Plan Mode"), Codicon.tasklist, 'plan'),
			mode('mode.agent', localize('nexusCommandPalette.agentMode', "Agent Mode"), Codicon.sync, 'agent'),
			mode('mode.ask', localize('nexusCommandPalette.askMode', "Ask Mode"), Codicon.question, 'ask'),
			mode('mode.debug', localize('nexusCommandPalette.debugMode', "Debug Mode"), Codicon.bug, 'debug'),
			inert('mode.multitask', localize('nexusCommandPalette.multitaskMode', "Multitask Mode"), Codicon.layers),
		],
	},
	{
		id: 'view',
		label: localize('nexusCommandPalette.view', "View"),
		rows: [
			command('view.minimap', localize('nexusCommandPalette.hideMinimap', "Hide Minimap"), Codicon.map, 'editor.action.toggleMinimap'),
			inert('view.gitBlame', localize('nexusCommandPalette.gitBlame', "Toggle Git Blame"), Codicon.gitCommit),
			inert('view.customize', localize('nexusCommandPalette.openCustomize', "Open Customize"), Codicon.layout),
			inert('view.plugins', localize('nexusCommandPalette.openPlugins', "Open Plugins"), Codicon.extensions),
			inert('view.mcps', localize('nexusCommandPalette.openMcps', "Open MCPs"), Codicon.mcp),
		],
	},
	{
		id: 'settings',
		label: localize('nexusCommandPalette.settings', "Settings"),
		rows: [
			command('settings.about', localize('nexusCommandPalette.about', "About NexusIDE"), Codicon.info, 'workbench.action.showAboutDialog'),
			command('settings.report', localize('nexusCommandPalette.reportIssue', "Report Issue"), Codicon.report, 'workbench.action.openIssueReporter'),
			command('settings.open', localize('nexusCommandPalette.openSettings', "Settings"), Codicon.settings, 'workbench.action.openSettings'),
			command('settings.keybindings', localize('nexusCommandPalette.keybindings', "Keyboard Shortcuts"), Codicon.keyboard, 'workbench.action.openGlobalKeybindings'),
			command('settings.update', localize('nexusCommandPalette.update', "Update NexusIDE"), Codicon.cloudDownload, 'update.checkForUpdate'),
		],
	},
	{
		id: 'appearance',
		label: localize('nexusCommandPalette.appearance', "Appearance"),
		rows: [
			{ id: 'appearance.light', label: localize('nexusCommandPalette.lightTheme', "Light Theme"), icon: Codicon.symbolColor, action: { kind: 'theme', themeId: ThemeSettingDefaults.COLOR_THEME_LIGHT } },
			{ id: 'appearance.dark', label: localize('nexusCommandPalette.darkTheme', "Dark Theme"), icon: Codicon.symbolColor, action: { kind: 'theme', themeId: ThemeSettingDefaults.COLOR_THEME_DARK } },
			{ id: 'appearance.system', label: localize('nexusCommandPalette.systemTheme', "System Theme"), icon: Codicon.colorMode, action: { kind: 'systemTheme' } },
			{ id: 'appearance.highContrast', label: localize('nexusCommandPalette.highContrastTheme', "High Contrast Theme"), icon: Codicon.symbolColor, action: { kind: 'theme', themeId: ThemeSettingDefaults.COLOR_THEME_HC_DARK } },
		],
	},
	{
		id: 'developer',
		label: localize('nexusCommandPalette.developer', "Developer"),
		rows: [
			inert('developer.resetAds', localize('nexusCommandPalette.resetAds', "Reset In-App Ad Views"), Codicon.clearAll),
			command('developer.reload', localize('nexusCommandPalette.reload', "Reload Window"), Codicon.refresh, 'workbench.action.reloadWindow'),
			command('developer.tools', localize('nexusCommandPalette.devTools', "Toggle Developer Tools"), Codicon.tools, 'workbench.action.toggleDevTools'),
			command('developer.logs', localize('nexusCommandPalette.logs', "Developer: Open Logs Folder"), Codicon.folder, 'workbench.action.openLogsFolder'),
			command('developer.userData', localize('nexusCommandPalette.userData', "Developer: Reveal User Data Folder"), Codicon.folderOpened, 'workbench.action.revealUserDataFolder'),
		],
	},
	{
		id: 'workspace',
		label: localize('nexusCommandPalette.workspace', "Workspace"),
		rows: [
			inert('workspace.ssh', localize('nexusCommandPalette.ssh', "Connect via SSH"), Codicon.remote),
			inert('workspace.wsl', localize('nexusCommandPalette.wsl', "Connect via WSL"), Codicon.vm),
			command('workspace.clone', localize('nexusCommandPalette.clone', "Clone Repository"), Codicon.repoClone, 'git.clone'),
			inert('workspace.sshConfig', localize('nexusCommandPalette.sshConfig', "Open SSH Configuration File"), Codicon.file),
			command('workspace.openFolder', localize('nexusCommandPalette.openFolder', "Open Folder"), Codicon.folderOpened, 'workbench.action.files.openFolder'),
		],
	},
	{
		id: 'models',
		label: localize('nexusCommandPalette.models', "New Agent with Model"),
		rows: [
			inert('models.grok47', localize('nexusCommandPalette.grok47', "Grok 4.7"), Codicon.sparkle),
			inert('models.grok46', localize('nexusCommandPalette.grok46', "Grok 4.6"), Codicon.sparkle),
			inert('models.opus', localize('nexusCommandPalette.opus', "Claude Opus 5.5"), Codicon.sparkle),
			inert('models.neon', localize('nexusCommandPalette.neon', "Gemini 4 Neon"), Codicon.sparkle),
			inert('models.carbon', localize('nexusCommandPalette.carbon', "Gemini 4 Carbon"), Codicon.sparkle),
		],
	},
	{
		id: 'sidebar',
		label: localize('nexusCommandPalette.sidebar', "Customize Sidebar"),
		rows: [
			inert('sidebar.workspace', localize('nexusCommandPalette.groupWorkspace', "Group by Workspace"), Codicon.folder),
			inert('sidebar.repository', localize('nexusCommandPalette.groupRepository', "Group by Repository"), Codicon.repo),
			inert('sidebar.updated', localize('nexusCommandPalette.groupUpdated', "Group by Updated"), Codicon.history),
			inert('sidebar.status', localize('nexusCommandPalette.groupStatus', "Group by Status"), Codicon.pulse),
			inert('sidebar.environment', localize('nexusCommandPalette.groupEnvironment', "Group by Environment"), Codicon.vm),
		],
	},
	{
		id: 'skills',
		label: localize('nexusCommandPalette.skills', "Skills"),
		rows: [
			inert('skills.cli', localize('nexusCommandPalette.skillCli', "agent-sdk-cli"), Codicon.package),
			inert('skills.create', localize('nexusCommandPalette.skillCreate', "agent-sdk-create-agent"), Codicon.package),
			inert('skills.debug', localize('nexusCommandPalette.skillDebug', "agent-sdk-debug"), Codicon.package),
			inert('skills.deploy', localize('nexusCommandPalette.skillDeploy', "agent-sdk-deploy"), Codicon.package),
			inert('skills.evals', localize('nexusCommandPalette.skillEvals', "agent-sdk-evals"), Codicon.package),
		],
	},
	{
		id: 'toggles',
		label: localize('nexusCommandPalette.toggles', "Settings"),
		rows: [
			inert('toggles.density', localize('nexusCommandPalette.toolCallDensity', "Tool Call Density"), Codicon.check),
			inert('toggles.usage', localize('nexusCommandPalette.usageSummary', "Usage Summary"), Codicon.check),
			inert('toggles.submit', localize('nexusCommandPalette.submitEnter', "Submit with Ctrl + Enter"), Codicon.check),
			inert('toggles.modeTransitions', localize('nexusCommandPalette.modeTransitions', "Auto-Approve Mode Transitions"), Codicon.check),
			inert('toggles.webSearch', localize('nexusCommandPalette.webSearch', "Auto-Accept Web Search"), Codicon.check),
		],
	},
];

/** The id of the command a mode row runs. Kept off the action union so mode stays a mode. */
export function nexusModeCommandId(): string {
	return NEXUS_CHAT_SET_MODE_COMMAND_ID;
}

export function nexusShowChatCommandId(): string {
	return NEXUS_CHAT_SHOW_COMMAND_ID;
}

/**
 * Sections visible for a tab and query. Matching is on the row label.
 * An empty query keeps every section in that tab, including Chats with no rows.
 * The Files tab has no command rows; file results are added by the palette.
 */
export function filterNexusCommandCatalog(sections: readonly INexusCommandSection[], query: string, tab: NexusCommandPaletteTab): readonly INexusCommandSection[] {
	const normalized = query.trim().toLowerCase();
	const inTab = sections.filter(section => {
		if (tab === 'files') {
			return false;
		}
		if (tab === 'chats') {
			return section.id === 'chats';
		}
		return true;
	});
	if (!normalized) {
		return inTab;
	}
	const matched: INexusCommandSection[] = [];
	for (const section of inTab) {
		const rows = section.rows.filter(row => row.label.toLowerCase().includes(normalized));
		if (rows.length) {
			matched.push({ ...section, rows });
		}
	}
	return matched;
}

/** Age text in the form `30s`, `5m`, `3h`, `7d`, `1mo`, `1y`. */
export function formatNexusCommandAge(updatedAt: number, now: number): string {
	const elapsed = Math.max(0, now - updatedAt);
	const minute = 60_000;
	const hour = 60 * minute;
	const day = 24 * hour;
	const month = 30 * day;
	const year = 365 * day;
	if (elapsed < minute) {
		return `${Math.floor(elapsed / 1000)}s`;
	}
	if (elapsed < hour) {
		return `${Math.floor(elapsed / minute)}m`;
	}
	if (elapsed < day) {
		return `${Math.floor(elapsed / hour)}h`;
	}
	if (elapsed < month) {
		return `${Math.floor(elapsed / day)}d`;
	}
	if (elapsed < year) {
		return `${Math.floor(elapsed / month)}mo`;
	}
	return `${Math.floor(elapsed / year)}y`;
}
