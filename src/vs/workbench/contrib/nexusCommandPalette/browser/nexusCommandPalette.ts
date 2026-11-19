/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NexusIDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/nexusCommandPalette.css';
import { Delayer } from '../../../../base/common/async.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { isCancellationError, onUnexpectedError } from '../../../../base/common/errors.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { $, append } from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { localize } from '../../../../nls.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { ConfigurationTarget } from '../../../../platform/configuration/common/configuration.js';
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { TriggerAction } from '../../../../platform/quickinput/browser/pickerQuickAccess.js';
import { IQuickInputService, IQuickPick, IQuickPickItem, IQuickPickItemButtonEvent, IQuickPickSeparator, NO_KEY_MODS } from '../../../../platform/quickinput/common/quickInput.js';
import { IWorkbenchThemeService } from '../../../services/themes/common/workbenchThemeService.js';
import { AnythingQuickAccessProvider, IAnythingQuickPickItem } from '../../search/browser/anythingQuickAccess.js';
import { INexusOpenChat, NEXUS_CHAT_GET_OPEN_CHAT_COMMAND_ID } from '../../nexusChat/common/nexusOpenChat.js';
import { INexusCommandRow, INexusCommandSection, NEXUS_COMMAND_PALETTE_PLACEHOLDER, NEXUS_COMMAND_SECTIONS, NexusCommandPaletteTab, filterNexusCommandCatalog, formatNexusCommandAge, nexusModeCommandId, nexusShowChatCommandId } from '../common/nexusCommandCatalog.js';

export const INexusCommandPaletteService = createDecorator<INexusCommandPaletteService>('nexusCommandPaletteService');

export interface INexusCommandPaletteService {
	readonly _serviceBrand: undefined;
	show(): void;
}

interface INexusPalettePick extends IQuickPickItem {
	readonly nexusRow?: INexusCommandRow;
}

const TABS: readonly NexusCommandPaletteTab[] = ['all', 'chats', 'files'];

/**
 * Cursor-style command palette. It owns its list and only calls commands,
 * the theme service, and the chat commands. It does not touch the chat widget.
 */
export class NexusCommandPalette extends Disposable implements INexusCommandPaletteService {

	declare readonly _serviceBrand: undefined;

	private picker: IQuickPick<INexusPalettePick, { useSeparators: true }> | undefined;
	private readonly header: HTMLElement;
	private readonly tabButtons = new Map<NexusCommandPaletteTab, HTMLButtonElement>();
	private tab: NexusCommandPaletteTab = 'all';
	private open = false;
	private session = 0;
	private openChat: INexusOpenChat | undefined;
	private fileGeneration = 0;
	private readonly fileDelayer = this._register(new Delayer<void>(200));
	private readonly fileToken = this._register(new MutableDisposable<CancellationTokenSource>());
	private readonly fileProvider = this._register(new MutableDisposable<AnythingQuickAccessProvider>());
	private accepting = false;

	constructor(
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@ICommandService private readonly commandService: ICommandService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@INotificationService private readonly notificationService: INotificationService,
		@IWorkbenchThemeService private readonly themeService: IWorkbenchThemeService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		this.header = this.createHeader();
	}

	show(): void {
		if (this.open) {
			return;
		}
		this.ensurePicker();
		const picker = this.picker!;
		this.open = true;
		this.tab = 'all';
		this.openChat = undefined;
		this.updateTabs();
		const session = ++this.session;
		if (picker.value !== '') {
			picker.value = '';
		} else {
			this.refreshSync();
		}
		picker.show();
		void this.loadOpenChat(session);
	}

	private ensurePicker(): void {
		if (this.picker) {
			return;
		}
		const picker = this.picker = this.quickInputService.createQuickPick<INexusPalettePick>({ useSeparators: true });
		this._register(picker);
		picker.placeholder = NEXUS_COMMAND_PALETTE_PLACEHOLDER;
		picker.containerClass = 'nexus-command-palette';
		picker.headerContent = this.header;
		picker.itemHeight = 32;
		picker.separatorHeight = 28;
		picker.matchOnLabel = false;
		picker.matchOnDescription = false;
		picker.matchOnDetail = false;
		picker.sortByLabel = false;
		picker.hideCountBadge = true;
		this._register(picker.onDidChangeValue(() => this.refreshSync()));
		this._register(picker.onDidAccept(() => {
			void this.accept(picker.selectedItems[0]);
		}));
		this._register(picker.onDidHide(() => this.onHide()));
		this._register(picker.onDidTriggerItemButton(event => {
			void this.triggerButton(event);
		}));
	}

	private createHeader(): HTMLElement {
		const bar = $('.nexus-command-palette-tabs');
		const tablist = append(bar, $('.nexus-command-palette-tablist'));
		tablist.setAttribute('role', 'tablist');
		const labels: Record<NexusCommandPaletteTab, string> = {
			all: localize('nexusCommandPalette.tabAll', "All"),
			chats: localize('nexusCommandPalette.tabChats', "Chats"),
			files: localize('nexusCommandPalette.tabFiles', "Files"),
		};
		for (const tab of TABS) {
			const button = append(tablist, $('button.nexus-command-palette-tab')) as HTMLButtonElement;
			button.type = 'button';
			button.tabIndex = -1;
			button.textContent = labels[tab];
			button.setAttribute('role', 'tab');
			button.setAttribute('aria-selected', 'false');
			this._register(this.addClick(button, () => this.setTab(tab)));
			this.tabButtons.set(tab, button);
		}
		const nav = append(bar, $('.nexus-command-palette-nav'));
		const previous = this.navButton(Codicon.chevronLeft, localize('nexusCommandPalette.previousTab', "Previous"));
		const next = this.navButton(Codicon.chevronRight, localize('nexusCommandPalette.nextTab', "Next"));
		nav.appendChild(previous);
		nav.appendChild(next);
		this._register(this.addClick(previous, () => this.cycle(-1)));
		this._register(this.addClick(next, () => this.cycle(1)));
		return bar;
	}

	private navButton(icon: ThemeIcon, label: string): HTMLButtonElement {
		const button = $('button') as HTMLButtonElement;
		button.type = 'button';
		button.tabIndex = -1;
		button.title = label;
		button.setAttribute('aria-label', label);
		button.appendChild(renderIcon(icon));
		return button;
	}

	private addClick(button: HTMLButtonElement, run: () => void): { dispose(): void } {
		const listener = (event: MouseEvent) => {
			event.preventDefault();
			event.stopPropagation();
			run();
		};
		button.addEventListener('click', listener);
		return { dispose: () => button.removeEventListener('click', listener) };
	}

	private setTab(tab: NexusCommandPaletteTab): void {
		if (this.tab === tab) {
			return;
		}
		this.tab = tab;
		this.updateTabs();
		this.refreshSync();
	}

	private cycle(delta: number): void {
		const index = TABS.indexOf(this.tab);
		const next = (index + delta + TABS.length) % TABS.length;
		this.setTab(TABS[next]);
	}

	private updateTabs(): void {
		for (const [tab, button] of this.tabButtons) {
			const selected = tab === this.tab;
			button.classList.toggle('active', selected);
			button.setAttribute('aria-selected', selected ? 'true' : 'false');
		}
	}

	private async loadOpenChat(session: number): Promise<void> {
		let chat: INexusOpenChat | undefined;
		try {
			chat = await this.commandService.executeCommand<INexusOpenChat | undefined>(NEXUS_CHAT_GET_OPEN_CHAT_COMMAND_ID);
		} catch (error) {
			if (!isCancellationError(error)) {
				onUnexpectedError(error);
			}
			return;
		}
		if (session !== this.session || !this.open) {
			return;
		}
		this.openChat = chat;
		this.refreshSync();
	}

	private refreshSync(): void {
		const picker = this.picker;
		if (!picker) {
			return;
		}
		const value = picker.value;
		if (value.startsWith('>')) {
			this.openClassic(value);
			return;
		}
		const sections = filterNexusCommandCatalog(this.sectionsWithChat(), value, this.tab);
		picker.items = this.tab === 'files' ? [] : this.toItems(sections);
		this.scheduleFiles(value);
	}

	private sectionsWithChat(): readonly INexusCommandSection[] {
		if (!this.openChat) {
			return NEXUS_COMMAND_SECTIONS;
		}
		const chat = this.openChat;
		const row: INexusCommandRow = {
			id: 'chats.open',
			label: chat.title,
			description: formatNexusCommandAge(chat.updatedAt, Date.now()),
			icon: Codicon.comment,
			action: { kind: 'command', commandId: nexusShowChatCommandId() },
		};
		return NEXUS_COMMAND_SECTIONS.map(section => section.id === 'chats' ? { ...section, rows: [row] } : section);
	}

	private toItems(sections: readonly INexusCommandSection[]): Array<INexusPalettePick | IQuickPickSeparator> {
		const items: Array<INexusPalettePick | IQuickPickSeparator> = [];
		for (const section of sections) {
			items.push({ type: 'separator', id: section.id, label: section.label, asItem: true });
			for (const row of section.rows) {
				items.push(this.toPick(row));
			}
		}
		return items;
	}

	private toPick(row: INexusCommandRow): INexusPalettePick {
		const commandId = row.action.kind === 'command' ? row.action.commandId : undefined;
		return {
			id: row.id,
			label: row.label,
			description: row.description,
			ariaLabel: row.description ? `${row.label}, ${row.description}` : row.label,
			iconClass: ThemeIcon.asClassName(row.icon),
			keybinding: commandId ? this.keybindingService.lookupKeybinding(commandId) : undefined,
			nexusRow: row,
		};
	}

	private scheduleFiles(value: string): void {
		this.fileDelayer.cancel();
		const query = value.trim();
		const wantFiles = this.tab === 'files' || (this.tab === 'all' && query.length > 0);
		if (!wantFiles || !this.picker) {
			this.fileGeneration++;
			this.fileToken.value?.cancel();
			this.fileToken.clear();
			if (this.picker) {
				this.picker.busy = false;
			}
			return;
		}
		const generation = ++this.fileGeneration;
		this.picker.busy = true;
		void this.fileDelayer.trigger(() => this.appendFiles(query, generation), query ? 200 : 0).catch(error => {
			if (!isCancellationError(error)) {
				onUnexpectedError(error);
			}
		});
	}

	private async appendFiles(query: string, generation: number): Promise<void> {
		const picker = this.picker;
		if (!picker || generation !== this.fileGeneration) {
			return;
		}
		this.fileToken.value?.cancel();
		const tokenSource = new CancellationTokenSource();
		this.fileToken.value = tokenSource;
		try {
			const picks = await this.files().getPaletteFilePicks(picker, query, tokenSource.token);
			if (tokenSource.token.isCancellationRequested || generation !== this.fileGeneration || !this.picker) {
				return;
			}
			const fileItems = this.presentFiles(picks, this.tab === 'all');
			if (this.tab === 'files') {
				this.picker.items = fileItems;
			} else {
				const sections = filterNexusCommandCatalog(this.sectionsWithChat(), this.picker.value, 'all');
				this.picker.items = [...this.toItems(sections), ...fileItems];
			}
		} catch (error) {
			if (!isCancellationError(error)) {
				onUnexpectedError(error);
			}
		} finally {
			if (generation === this.fileGeneration && this.picker) {
				this.picker.busy = false;
			}
		}
	}

	private files(): AnythingQuickAccessProvider {
		if (!this.fileProvider.value) {
			this.fileProvider.value = this.instantiationService.createInstance(AnythingQuickAccessProvider);
		}
		return this.fileProvider.value;
	}

	private presentFiles(picks: readonly (IAnythingQuickPickItem | IQuickPickSeparator)[], singleHeader: boolean): Array<INexusPalettePick | IQuickPickSeparator> {
		if (singleHeader) {
			const items = picks.filter((pick): pick is IAnythingQuickPickItem => pick.type !== 'separator');
			if (!items.length) {
				return [];
			}
			return [{ type: 'separator', id: 'files', label: localize('nexusCommandPalette.filesHeader', "Files"), asItem: true }, ...items];
		}
		return picks.map(pick => pick.type === 'separator' ? { ...pick, asItem: true } : pick);
	}

	private openClassic(value: string): void {
		if (!this.open) {
			return;
		}
		this.picker?.hide();
		this.quickInputService.quickAccess.show(value);
	}

	private async accept(item: INexusPalettePick | undefined): Promise<void> {
		if (this.accepting || !item || item.type === 'separator') {
			return;
		}
		const fileItem = item as IAnythingQuickPickItem;
		const keyMods = this.picker?.keyMods ?? NO_KEY_MODS;
		if (!item.nexusRow && typeof fileItem.accept === 'function') {
			this.accepting = true;
			this.picker?.hide();
			try {
				await fileItem.accept(keyMods, { inBackground: false });
			} catch (error) {
				if (!isCancellationError(error)) {
					onUnexpectedError(error);
				}
			} finally {
				this.accepting = false;
			}
			return;
		}
		if (!item.nexusRow) {
			return;
		}
		this.accepting = true;
		this.picker?.hide();
		try {
			await this.run(item.nexusRow);
		} catch (error) {
			if (!isCancellationError(error)) {
				onUnexpectedError(error);
			}
		} finally {
			this.accepting = false;
		}
	}

	private async triggerButton(event: IQuickPickItemButtonEvent<INexusPalettePick>): Promise<void> {
		const item = event.item as IAnythingQuickPickItem;
		if (typeof item.trigger !== 'function') {
			return;
		}
		const index = item.buttons?.indexOf(event.button) ?? -1;
		const result = await item.trigger(index, this.picker?.keyMods ?? NO_KEY_MODS);
		if (result === TriggerAction.CLOSE_PICKER) {
			this.picker?.hide();
		}
	}

	private async run(row: INexusCommandRow): Promise<void> {
		const action = row.action;
		switch (action.kind) {
			case 'inert':
				this.unavailable();
				return;
			case 'command':
				if (!CommandsRegistry.getCommand(action.commandId)) {
					this.unavailable();
					return;
				}
				await this.commandService.executeCommand(action.commandId);
				return;
			case 'theme': {
				const theme = await this.themeService.setColorTheme(action.themeId, ConfigurationTarget.USER);
				if (!theme) {
					this.unavailable();
				}
				return;
			}
			case 'systemTheme':
				if (!CommandsRegistry.getCommand('workbench.action.toggleLightDarkThemes')) {
					this.unavailable();
					return;
				}
				await this.commandService.executeCommand('workbench.action.toggleLightDarkThemes');
				return;
			case 'mode':
				await this.commandService.executeCommand(nexusModeCommandId(), action.mode);
				return;
		}
	}

	private unavailable(): void {
		this.notificationService.info(localize('nexusCommandPalette.unavailable', "This command is not available in NexusIDE yet."));
	}

	private onHide(): void {
		this.open = false;
		this.session++;
		this.fileGeneration++;
		this.fileDelayer.cancel();
		this.fileToken.value?.cancel();
		this.fileToken.clear();
		if (this.picker) {
			this.picker.busy = false;
		}
	}
}
