/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NexusIDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ModesRegistry } from '../../../../../editor/common/languages/modesRegistry.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { TestClipboardService } from '../../../../../platform/clipboard/test/common/testClipboardService.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { MarkerService } from '../../../../../platform/markers/common/markerService.js';
import { IMarkerService, MarkerSeverity } from '../../../../../platform/markers/common/markers.js';
import { Event } from '../../../../../base/common/event.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IAIProviderInfo, IAIService } from '../../../../../platform/ai/common/ai.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { TestWorkspace, testWorkspace } from '../../../../../platform/workspace/test/common/testWorkspace.js';
import { IViewContainerModel, IViewDescriptorService, ViewContainer, ViewContainerLocation } from '../../../../common/views.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { WebviewInput } from '../../../webviewPanel/browser/webviewEditorInput.js';
import { IWebviewWorkbenchService } from '../../../webviewPanel/browser/webviewWorkbenchService.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { TestViewsService, workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { PREVIEW_CONTENT_SECURITY_POLICY } from '../../browser/nexusChatPreview.js';
import { NexusChatViewPane } from '../../browser/nexusChatView.js';
import { TestAIService } from '../common/testAIService.js';

class TestViewDescriptorService extends mock<IViewDescriptorService>() {
	override readonly onDidChangeLocation = Event.None;

	override getViewLocationById(): ViewContainerLocation {
		return ViewContainerLocation.Sidebar;
	}

	override getViewDescriptorById(): null {
		return null;
	}

	override getViewContainerByViewId(): ViewContainer {
		return new class extends mock<ViewContainer>() {
			override readonly id = 'workbench.view.nexusChatTest';
		};
	}

	override getViewContainerModel(): IViewContainerModel {
		return new class extends mock<IViewContainerModel>() {
			override readonly title = 'NexusIDE Chat';
			override readonly onDidChangeContainerInfo = Event.None;
		};
	}

	override getDefaultContainerById(): null {
		return null;
	}
}

/** Lets pending promise callbacks settle. */
function settle(): Promise<void> {
	return timeout(0);
}

function provider(id: string, available: boolean): IAIProviderInfo {
	return { id, displayName: id === 'claude-cli' ? 'Claude Code CLI' : id, kind: 'cli', available };
}

suite('NexusChatViewPane', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	async function createPane(providers: readonly IAIProviderInfo[], options: { readonly noFolder?: boolean } = {}) {
		const aiService = store.add(new TestAIService());
		aiService.providers = providers;
		const instantiationService = workbenchInstantiationService(undefined, store);
		instantiationService.stub(IViewDescriptorService, new TestViewDescriptorService());
		instantiationService.stub(IViewsService, new TestViewsService());
		instantiationService.stub(IAIService, aiService);
		// The default test marker service does nothing; Fix mode reads real markers.
		const markerService = store.add(new MarkerService());
		instantiationService.stub(IMarkerService, markerService);
		// Code blocks are highlighted with the editor font.
		instantiationService.stub(IConfigurationService, new TestConfigurationService({ editor: { fontFamily: 'monospace' } }));
		if (options.noFolder) {
			instantiationService.stub(IWorkspaceContextService, 'getWorkspace', () => testWorkspace());
		}

		// Records what code block buttons do instead of touching real editors, files and the clipboard.
		const clipboard = new TestClipboardService();
		instantiationService.stub(IClipboardService, clipboard);
		const artifacts = {
			saveTarget: undefined as URI | undefined,
			saveDialogDefaults: [] as (string | undefined)[],
			writtenFiles: [] as { readonly path: string; readonly content: string }[],
			openedEditors: [] as unknown[],
			/** HTML of each opened preview, and how often an open preview was revealed again. */
			previews: [] as string[],
			previewReveals: 0,
			clipboard,
		};
		instantiationService.stub(IWebviewWorkbenchService, new class extends mock<IWebviewWorkbenchService>() {
			override openWebview() {
				const webview = new class extends mock<WebviewInput['webview']>() {
					override setHtml(html: string) { artifacts.previews.push(html); }
				};
				return new class extends mock<WebviewInput>() {
					override get webview() { return webview; }
					override get group() { return undefined; }
					override readonly onWillDispose = Event.None;
					override isDisposed() { return false; }
				};
			}
			override revealWebview() {
				artifacts.previewReveals++;
			}
		});
		instantiationService.stub(IFileDialogService, 'showSaveDialog', async (dialogOptions: { defaultUri?: URI }) => {
			artifacts.saveDialogDefaults.push(dialogOptions.defaultUri?.path);
			return artifacts.saveTarget;
		});
		instantiationService.stub(IFileService, 'writeFile', async (resource: URI, content: VSBuffer) => {
			artifacts.writtenFiles.push({ path: resource.path, content: content.toString() });
			return undefined;
		});
		instantiationService.stub(IEditorService, 'openEditor', async (editor: unknown) => {
			artifacts.openedEditors.push(editor);
			return undefined;
		});

		const pane = store.add(instantiationService.createInstance(NexusChatViewPane, { id: 'nexusChatTest', title: 'NexusIDE Chat' }));
		const container = document.createElement('div');
		document.body.appendChild(container);
		store.add({ dispose: () => container.remove() });
		pane.render();
		container.appendChild(pane.element);
		pane.setExpanded(true);
		pane.layout(400);
		await settle();

		const query = <T extends Element>(selector: string): T => {
			const element = pane.element.querySelector<T>(selector);
			assert.ok(element, `missing element ${selector}`);
			return element;
		};
		const input = query<HTMLTextAreaElement>('.nexus-chat-prompt');
		const pressEnter = (shiftKey = false) => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey, bubbles: true, cancelable: true }));
		const messageTexts = () => [...pane.element.querySelectorAll('.nexus-chat-message')].map(message => ({
			role: message.querySelector('.nexus-chat-message-role')?.textContent,
			// A reply shows one element per text part, and none while it is empty.
			text: [...message.querySelectorAll('.nexus-chat-message-text')].map(part => part.textContent).join(''),
			status: message.querySelector<HTMLElement>('.nexus-chat-message-status')?.textContent,
		}));

		return { aiService, pane, query, input, pressEnter, messageTexts, artifacts, markerService };
	}

	test('sends with Enter, streams the reply as markdown and switches Send to Stop', async () => {
		const { aiService, query, input, pressEnter, messageTexts } = await createPane([provider('claude-cli', true), provider('echo', true)]);

		assert.strictEqual(query<HTMLSelectElement>('.nexus-chat-provider').value, 'claude-cli');
		assert.strictEqual(query('.nexus-chat-send').textContent, 'Send');

		query<HTMLSelectElement>('.nexus-chat-select').value = 'plan';
		input.value = 'What does this repo do?';
		pressEnter(true);
		await settle();
		assert.strictEqual(aiService.requests.length, 0, 'Shift+Enter does not send');

		pressEnter();
		await settle();
		assert.strictEqual(aiService.requests.length, 1);
		assert.strictEqual(aiService.requests[0].prompt, 'What does this repo do?');
		assert.strictEqual(aiService.requests[0].mode, 'plan');
		assert.strictEqual(aiService.requests[0].providerId, 'claude-cli');
		assert.strictEqual(input.value, '', 'the prompt box is cleared after sending');
		assert.strictEqual(query('.nexus-chat-send').textContent, 'Stop');
		assert.deepStrictEqual(messageTexts(), [
			{ role: 'You', text: 'What does this repo do?', status: '' },
			{ role: 'AI', text: '', status: 'Thinking…' },
		]);

		const streamId = aiService.streamIds[0];
		aiService.hub.appendText(streamId, '<b>not bold</b> ');
		aiService.hub.appendText(streamId, 'done');
		aiService.hub.end(streamId, 'completed');

		assert.deepStrictEqual(messageTexts()[1], { role: 'AI', text: '<b>not bold</b> done', status: '' });
		assert.strictEqual(query('.nexus-chat-message.assistant .nexus-chat-message-text').querySelector('b'), null, 'reply text is never parsed as HTML');
		assert.strictEqual(query('.nexus-chat-send').textContent, 'Send');
	});

	test('Stop cancels the reply and the reply shows as stopped', async () => {
		const { aiService, query, input, pressEnter, messageTexts } = await createPane([provider('claude-cli', true)]);
		input.value = 'hi';
		pressEnter();
		await settle();

		query<HTMLElement>('.nexus-chat-send').click();
		await settle();
		assert.strictEqual(aiService.cancelledThreads.length, 1);

		aiService.hub.end(aiService.streamIds[0], 'cancelled');
		assert.strictEqual(messageTexts()[1].status, 'Stopped.');
		assert.strictEqual(query('.nexus-chat-send').textContent, 'Send');
	});

	test('shows the error of a failed reply', async () => {
		const { aiService, input, pressEnter, messageTexts } = await createPane([provider('claude-cli', true)]);
		aiService.sendResponse = async () => ({ ok: false, error: 'Provider Claude Code CLI is not available.' });
		input.value = 'hi';
		pressEnter();
		await settle();

		assert.deepStrictEqual(messageTexts()[1], { role: 'AI', text: '', status: 'Error: Provider Claude Code CLI is not available.' });
	});

	test('explains what to do when no provider is available and sends nothing', async () => {
		const { aiService, query, input, pressEnter, messageTexts } = await createPane([provider('claude-cli', false)]);

		const select = query<HTMLSelectElement>('.nexus-chat-provider');
		assert.deepStrictEqual([...select.options].map(option => [option.textContent, option.disabled]), [['Claude Code CLI (not available)', true]]);

		input.value = 'hi';
		pressEnter();
		await settle();

		assert.strictEqual(aiService.requests.length, 0);
		assert.deepStrictEqual(messageTexts(), []);
		const notice = query<HTMLElement>('.nexus-chat-notice');
		assert.strictEqual(notice.style.display, 'block');
		assert.ok(notice.textContent?.includes('Claude Code CLI'), notice.textContent ?? '');
		assert.strictEqual(input.value, 'hi', 'the prompt is kept');
	});

	test('Agent mode shows tool activity and Allow/Deny cards that send the answer', async () => {
		const { aiService, pane, query, input, pressEnter } = await createPane([provider('claude-cli', true)]);
		const modeSelect = query<HTMLSelectElement>('.nexus-chat-select');
		// The debug mode is labelled Fix, so it is not confused with the Run and Debug view.
		assert.deepStrictEqual([...modeSelect.options].map(option => [option.value, option.textContent]), [['ask', 'Ask'], ['plan', 'Plan'], ['agent', 'Agent'], ['debug', 'Fix']]);
		modeSelect.value = 'agent';
		input.value = 'clean up';
		pressEnter();
		await settle();
		assert.strictEqual(aiService.requests[0].mode, 'agent');

		const streamId = aiService.streamIds[0];
		aiService.hub.appendEvent(streamId, { kind: 'tool', summary: 'Read a.ts', failed: false });
		aiService.hub.appendEvent(streamId, { kind: 'permission', requestId: 'r1', toolName: 'Bash', summary: 'Run: rm -rf build', detail: 'rm -rf build\necho <b>x</b>' });
		const cards = () => [...pane.element.querySelectorAll<HTMLElement>('.nexus-chat-permission')].map(card => ({
			summary: card.querySelector('.nexus-chat-permission-summary')?.textContent,
			detail: card.querySelector('.nexus-chat-permission-detail')?.textContent,
			buttons: card.querySelector<HTMLElement>('.nexus-chat-permission-actions')?.style.display === 'none'
				? 'hidden'
				: [...card.querySelectorAll('.monaco-button')].map(button => `${button.textContent}${button.classList.contains('disabled') ? ' (disabled)' : ''}`).join(', '),
			outcome: card.querySelector('.nexus-chat-permission-outcome')?.textContent,
		}));

		assert.strictEqual(query('.nexus-chat-tool-label').textContent, 'Read a.ts');
		assert.deepStrictEqual(cards(), [{ summary: 'Run: rm -rf build', detail: 'rm -rf build\necho <b>x</b>', buttons: 'Allow, Deny', outcome: '' }]);
		assert.strictEqual(query('.nexus-chat-permission-detail').querySelector('b'), null, 'the detail is never parsed as HTML');

		query<HTMLElement>('.nexus-chat-deny').click();
		await settle();
		assert.deepStrictEqual(aiService.permissionAnswers.map(({ requestId, decision }) => ({ requestId, decision })), [{ requestId: 'r1', decision: 'deny' }]);

		aiService.hub.appendEvent(streamId, { kind: 'permissionResolved', requestId: 'r1', decision: 'deny' });
		aiService.hub.appendEvent(streamId, { kind: 'tool', summary: 'Run: rm -rf build', failed: true });
		assert.deepStrictEqual(cards(), [{ summary: 'Run: rm -rf build', detail: 'rm -rf build\necho <b>x</b>', buttons: 'hidden', outcome: 'Denied.' }]);
		assert.deepStrictEqual([...pane.element.querySelectorAll('.nexus-chat-tool-label')].map(label => label.textContent), ['Read a.ts', 'Run: rm -rf build (failed or denied)']);

		aiService.hub.appendEvent(streamId, { kind: 'permission', requestId: 'r2', toolName: 'Edit', summary: 'Edit a.ts' });
		[...pane.element.querySelectorAll<HTMLElement>('.nexus-chat-allow')].at(-1)!.click();
		await settle();
		assert.deepStrictEqual(aiService.permissionAnswers.map(({ requestId, decision }) => ({ requestId, decision })).at(-1), { requestId: 'r2', decision: 'allow' });
		aiService.hub.appendEvent(streamId, { kind: 'permissionResolved', requestId: 'r2', decision: 'allow' });
		assert.strictEqual(cards()[1].outcome, 'Allowed.');

		aiService.hub.appendEvent(streamId, { kind: 'permission', requestId: 'r3', toolName: 'Edit', summary: 'Edit b.ts' });
		aiService.hub.end(streamId, 'cancelled');
		assert.strictEqual(cards()[2].buttons, 'Allow (disabled), Deny (disabled)', 'requests of an ended reply cannot be answered');
	});

	test('Fix mode sends the Problems panel errors of the folder with the prompt', async () => {
		const { aiService, query, input, pressEnter, messageTexts, markerService } = await createPane([provider('claude-cli', true)]);
		const workspaceFile = joinPath(TestWorkspace.folders[0].uri, 'src', 'app.ts');
		markerService.changeOne('test', workspaceFile, [{ severity: MarkerSeverity.Error, message: 'Cannot find name x', startLineNumber: 4, startColumn: 1, endLineNumber: 4, endColumn: 2, source: 'ts' }]);
		markerService.changeOne('test', URI.file('/elsewhere/other.ts'), [{ severity: MarkerSeverity.Error, message: 'not in the folder', startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 }]);

		query<HTMLSelectElement>('.nexus-chat-select').value = 'debug';
		input.value = 'why does it fail?';
		pressEnter();
		await settle();

		assert.deepStrictEqual({ mode: aiService.requests[0].mode, prompt: aiService.requests[0].prompt, user: messageTexts()[0] }, {
			mode: 'debug',
			prompt: 'why does it fail?\n\n<problems source="NexusIDE Problems panel">\nsrc/app.ts:4:1 error: Cannot find name x (ts)\n</problems>',
			user: { role: 'You', text: 'why does it fail?', status: 'Included 1 problem from the Problems panel.' },
		});
	});

	test('Agent mode explains that it needs an open folder and sends nothing', async () => {
		const { aiService, query, input, pressEnter } = await createPane([provider('claude-cli', true)], { noFolder: true });
		query<HTMLSelectElement>('.nexus-chat-select').value = 'agent';
		input.value = 'clean up';
		pressEnter();
		await settle();

		assert.strictEqual(aiService.requests.length, 0);
		assert.strictEqual(query('.nexus-chat-notice').textContent, 'Agent mode needs a folder on disk. Open a folder, then try again.');
		assert.strictEqual(input.value, 'clean up', 'the prompt is kept');
	});

	test('renders reply markdown with code blocks that have artifact buttons', async () => {
		store.add(ModesRegistry.registerLanguage({ id: 'nexusTestLanguage', extensions: ['.ntl'], aliases: ['NexusTest', 'ntl'] }));
		const { aiService, pane, query, input, pressEnter, artifacts } = await createPane([provider('claude-cli', true)]);
		input.value = 'show me';
		pressEnter();
		await settle();

		const streamId = aiService.streamIds[0];
		aiService.hub.appendText(streamId, '# Result\n\n- one\n- `two`\n\nList<T> stays.\n\n![tracker](https://example.com/p.png?data=secret)\n\n```ntl\nlet x = 1;\n```\n');
		aiService.hub.end(streamId, 'completed');
		await settle();

		const markdown = query('.nexus-chat-message.assistant .nexus-chat-markdown');
		assert.deepStrictEqual({
			heading: markdown.querySelector('h1')?.textContent,
			items: [...markdown.querySelectorAll('li')].map(item => item.textContent),
			inlineCode: markdown.querySelector('li code')?.textContent,
			generic: [...markdown.querySelectorAll('p')].map(p => p.textContent).find(text => text?.includes('stays')),
			remoteImages: [...markdown.querySelectorAll('img')].map(img => img.getAttribute('src')).filter(src => src?.startsWith('http')),
			language: query('.nexus-chat-codeblock-language').textContent,
			languageId: query<HTMLElement>('.nexus-chat-codeblock').dataset.languageId,
			code: query('.nexus-chat-codeblock-body').textContent,
			buttons: [...pane.element.querySelectorAll('.nexus-chat-codeblock-action')].map(button => button.getAttribute('aria-label')),
		}, {
			heading: 'Result',
			items: ['one', 'two'],
			inlineCode: 'two',
			generic: 'List<T> stays.',
			remoteImages: [],
			language: 'ntl',
			languageId: 'nexusTestLanguage',
			code: 'let x = 1;',
			buttons: ['Copy', 'Insert at Cursor', 'Save as File...', 'Open in Editor'],
		});

		const click = async (action: string) => {
			query<HTMLElement>(`.nexus-chat-codeblock-action.${action}`).click();
			await settle();
		};
		await click('copy');
		await click('open');
		await click('insert');
		artifacts.saveTarget = URI.file('/work/saved.ntl');
		await click('save');

		assert.deepStrictEqual({
			clipboard: await artifacts.clipboard.readText(),
			saveDialogDefaults: artifacts.saveDialogDefaults,
			writtenFiles: artifacts.writtenFiles,
			openedEditors: artifacts.openedEditors,
			notice: query('.nexus-chat-notice').textContent,
		}, {
			clipboard: 'let x = 1;',
			saveDialogDefaults: [URI.file('/testWorkspace/untitled.ntl').path],
			writtenFiles: [{ path: URI.file('/work/saved.ntl').path, content: 'let x = 1;' }],
			openedEditors: [
				{ resource: undefined, contents: 'let x = 1;', languageId: 'nexusTestLanguage', options: { pinned: true } },
				{ resource: URI.file('/work/saved.ntl'), options: { pinned: true } },
			],
			notice: 'Open a file to insert the code into.',
		});
	});

	test('HTML and SVG code blocks get a Preview that opens a sandboxed page', async () => {
		const { aiService, pane, input, pressEnter, artifacts } = await createPane([provider('claude-cli', true)]);
		input.value = 'make a page';
		pressEnter();
		await settle();

		const streamId = aiService.streamIds[0];
		aiService.hub.appendText(streamId, '```html\n<button>Hi</button>\n```\n\n```svg\n<svg></svg>\n```\n\n```text\nplain\n```\n');
		aiService.hub.end(streamId, 'completed');
		await settle();

		const blocks = [...pane.element.querySelectorAll<HTMLElement>('.nexus-chat-codeblock')];
		assert.deepStrictEqual(blocks.map(block => block.querySelector('.nexus-chat-codeblock-action.preview') !== null), [true, true, false]);

		const preview = blocks[0].querySelector<HTMLElement>('.nexus-chat-codeblock-action.preview')!;
		preview.click();
		await settle();
		preview.click();
		await settle();
		assert.deepStrictEqual({ previews: artifacts.previews, reveals: artifacts.previewReveals }, {
			previews: [`<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CONTENT_SECURITY_POLICY}"><button>Hi</button>`],
			reveals: 1,
		});
	});

	test('New chat clears the messages', async () => {
		const { aiService, pane, input, pressEnter, messageTexts } = await createPane([provider('claude-cli', true)]);
		input.value = 'hi';
		pressEnter();
		await settle();
		aiService.hub.end(aiService.streamIds[0], 'completed');
		assert.strictEqual(messageTexts().length, 2);

		pane.newChat();
		assert.deepStrictEqual(messageTexts(), []);
	});
});
