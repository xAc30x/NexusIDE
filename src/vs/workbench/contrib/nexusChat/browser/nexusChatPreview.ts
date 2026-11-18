/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NexusIDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { WebviewInput } from '../../webviewPanel/browser/webviewEditorInput.js';
import { IWebviewWorkbenchService } from '../../webviewPanel/browser/webviewWorkbenchService.js';
import { SIDE_GROUP } from '../../../services/editor/common/editorService.js';

/** What a code block can be previewed as. */
export type NexusChatPreviewKind = 'html' | 'svg';

const PREVIEW_VIEW_TYPE = 'nexusChat.preview';

/**
 * Content security policy of every preview. Inline scripts and styles run, so
 * interactive pages work, but nothing can be loaded from the network or the
 * file system: only `data:` images and fonts are allowed.
 */
export const PREVIEW_CONTENT_SECURITY_POLICY = `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:`;

/**
 * Returns what a code block can be previewed as, or `undefined`. HTML is
 * recognized by its language, SVG by its fence label because SVG has no
 * language of its own.
 */
export function getPreviewKind(languageAlias: string | undefined, languageId: string): NexusChatPreviewKind | undefined {
	const alias = languageAlias?.toLowerCase();
	if (languageId === 'html' || alias === 'html' || alias === 'htm') {
		return 'html';
	}
	if (alias === 'svg') {
		return 'svg';
	}
	return undefined;
}

/**
 * Builds the page shown in a preview: the code with the
 * {@link PREVIEW_CONTENT_SECURITY_POLICY} in front of it.
 */
export function buildPreviewDocument(kind: NexusChatPreviewKind, code: string): string {
	const policy = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CONTENT_SECURITY_POLICY}">`;
	if (kind === 'svg') {
		return `<!DOCTYPE html><html><head>${policy}<style>body { margin: 0; padding: 8px; }</style></head><body>${code}</body></html>`;
	}
	// The policy must come before anything the page loads or runs. A leading
	// doctype is kept first so the page is not rendered in quirks mode.
	const doctype = /^\s*<!doctype[^>]*>/i.exec(code);
	return doctype
		? `${doctype[0]}${policy}${code.slice(doctype[0].length)}`
		: `${policy}${code}`;
}

/**
 * Opens previews of chat code blocks in webview editors beside the active
 * editor. Previewing the same code again reveals its open tab.
 */
export class NexusChatPreviews extends Disposable {

	/** Open previews by kind and code. Entries are removed when their tab closes. */
	private readonly openPreviews = new Map<string, WebviewInput>();
	private readonly closeListeners = this._register(new DisposableMap<string>());

	constructor(
		@IWebviewWorkbenchService private readonly webviewWorkbenchService: IWebviewWorkbenchService,
	) {
		super();
	}

	open(kind: NexusChatPreviewKind, code: string): void {
		const key = `${kind}:${code}`;
		const existing = this.openPreviews.get(key);
		if (existing && !existing.isDisposed()) {
			this.webviewWorkbenchService.revealWebview(existing, existing.group ?? SIDE_GROUP, false);
			return;
		}

		const title = kind === 'svg'
			? localize('nexusChat.previewSvgTitle', "Preview: SVG")
			: localize('nexusChat.previewHtmlTitle', "Preview: HTML");
		const input = this.webviewWorkbenchService.openWebview({
			providedViewType: PREVIEW_VIEW_TYPE,
			title,
			options: { enableFindWidget: true },
			// Forms stay disabled and no local resources can be loaded.
			contentOptions: { allowScripts: true, allowForms: false, localResourceRoots: [] },
			extension: undefined,
		}, PREVIEW_VIEW_TYPE, title, undefined, { group: SIDE_GROUP, preserveFocus: false });
		input.webview.setHtml(buildPreviewDocument(kind, code));

		this.openPreviews.set(key, input);
		this.closeListeners.set(key, input.onWillDispose(() => {
			this.openPreviews.delete(key);
			this.closeListeners.deleteAndDispose(key);
		}));
	}
}
