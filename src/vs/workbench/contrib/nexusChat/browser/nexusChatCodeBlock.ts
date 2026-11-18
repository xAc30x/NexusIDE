/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NexusIDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { getErrorMessage } from '../../../../base/common/errors.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { getCodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { EditorMarkdownCodeBlockRenderer } from '../../../../editor/browser/widget/markdownRenderer/browser/editorMarkdownCodeBlockRenderer.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { PLAINTEXT_LANGUAGE_ID } from '../../../../editor/common/languages/modesRegistry.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';

/**
 * Where a code block action reports problems and how it opens a live preview.
 */
export interface INexusChatCodeBlockHost {
	/** Shows a message under the prompt box. */
	showNotice(message: string): void;
	/** Opens a live preview of `code`. Omitted when previews are not available. */
	readonly preview?: (languageId: string, code: string) => void;
	/** Whether a block in this language gets a Preview button. */
	canPreview(languageId: string): boolean;
}

/**
 * Renders the code blocks of chat replies: syntax highlighted, with a header
 * that shows the language and Copy, Insert at Cursor, Save as File, Open in
 * Editor and (for previewable languages) Preview buttons.
 */
export class NexusChatCodeBlockRenderer {

	private readonly highlighter: EditorMarkdownCodeBlockRenderer;

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@ILanguageService private readonly languageService: ILanguageService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@IEditorService private readonly editorService: IEditorService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) {
		this.highlighter = instantiationService.createInstance(EditorMarkdownCodeBlockRenderer);
	}

	/**
	 * Renders one code block. Buttons are added to `disposables`; once it is
	 * disposed, a block that finishes rendering later gets no buttons.
	 */
	async render(languageAlias: string | undefined, code: string, disposables: DisposableStore, host: INexusChatCodeBlockHost): Promise<HTMLElement> {
		const languageId = this.resolveLanguage(languageAlias);
		const highlighted = await this.highlighter.renderCodeBlock(languageAlias, code, {});

		const root = $('.nexus-chat-codeblock');
		root.dataset.languageId = languageId;
		const header = append(root, $('.nexus-chat-codeblock-header'));
		const label = append(header, $('span.nexus-chat-codeblock-language'));
		label.textContent = languageAlias || this.languageService.getLanguageName(languageId) || languageId;
		const toolbar = append(header, $('.nexus-chat-codeblock-actions'));
		const body = append(root, $('.nexus-chat-codeblock-body'));
		body.appendChild(highlighted);

		if (disposables.isDisposed) {
			return root;
		}

		const addButton = (className: string, icon: ThemeIcon, title: string, run: () => Promise<void> | void) => {
			const button = disposables.add(new Button(toolbar, { ...defaultButtonStyles, secondary: true, small: true, supportIcons: true, title, ariaLabel: title }));
			button.label = `$(${icon.id})`;
			button.element.classList.add('nexus-chat-codeblock-action', className);
			disposables.add(button.onDidClick(async () => {
				try {
					await run();
				} catch (error) {
					host.showNotice(localize('nexusChat.codeBlockActionFailed', "{0} failed: {1}", title, getErrorMessage(error)));
				}
			}));
		};

		addButton('copy', Codicon.copy, localize('nexusChat.copyCode', "Copy"), () => this.clipboardService.writeText(code));
		addButton('insert', Codicon.insert, localize('nexusChat.insertCode', "Insert at Cursor"), () => this.insertAtCursor(code, host));
		addButton('save', Codicon.save, localize('nexusChat.saveCode', "Save as File..."), () => this.saveAsFile(languageId, code));
		addButton('open', Codicon.goToFile, localize('nexusChat.openCode', "Open in Editor"), async () => {
			await this.editorService.openEditor({ resource: undefined, contents: code, languageId, options: { pinned: true } });
		});
		const preview = host.preview;
		if (preview && host.canPreview(languageId)) {
			addButton('preview', Codicon.openPreview, localize('nexusChat.previewCode', "Preview"), () => preview(languageId, code));
		}
		return root;
	}

	private resolveLanguage(languageAlias: string | undefined): string {
		return (languageAlias && this.languageService.getLanguageIdByLanguageName(languageAlias)) || PLAINTEXT_LANGUAGE_ID;
	}

	/** Replaces every selection of the active text editor with `code`. */
	private insertAtCursor(code: string, host: INexusChatCodeBlockHost): void {
		const editor = getCodeEditor(this.editorService.activeTextEditorControl);
		if (!editor?.hasModel()) {
			host.showNotice(localize('nexusChat.noEditorToInsert', "Open a file to insert the code into."));
			return;
		}
		const edits = editor.getSelections().map(range => ({ range, text: code }));
		if (!editor.executeEdits('nexusChat', edits)) {
			host.showNotice(localize('nexusChat.editorReadonly', "The active editor is read-only."));
			return;
		}
		editor.focus();
	}

	private async saveAsFile(languageId: string, code: string): Promise<void> {
		const extension = this.languageService.getExtensions(languageId)[0] ?? '.txt';
		const folder = this.workspaceContextService.getWorkspace().folders[0]?.uri;
		const fileName = `untitled${extension}`;
		const target = await this.fileDialogService.showSaveDialog({
			title: localize('nexusChat.saveCodeTitle', "Save Code Block"),
			defaultUri: folder ? joinPath(folder, fileName) : undefined,
		});
		if (!target) {
			return;
		}
		await this.fileService.writeFile(target, VSBuffer.fromString(code));
		await this.editorService.openEditor({ resource: target, options: { pinned: true } });
	}
}
