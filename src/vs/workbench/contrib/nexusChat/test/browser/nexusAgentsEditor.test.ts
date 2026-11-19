/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NexusIDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IAIService } from '../../../../../platform/ai/common/ai.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { MockContextKeyService } from '../../../../../platform/keybinding/test/common/mockKeybindingService.js';
import { IWorkspaceTrustManagementService, IWorkspaceTrustUriInfo } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { GroupModelChangeKind } from '../../../../common/editor.js';
import { IEditorService, IEditorsChangeEvent } from '../../../../services/editor/common/editorService.js';
import { IWorkbenchLayoutService, Parts } from '../../../../services/layout/browser/layoutService.js';
import { TestEditorGroupView, workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { InNexusAgentsWindowContext, NexusAgentsEditorInput, NexusAgentsEditorPane, NexusAgentsEditorSerializer, NexusAgentsWindowContextContribution, nexusAgentsFolder, nexusAgentsResource, showNexusAgentsChat } from '../../browser/nexusAgentsEditor.js';
import { TestAIService } from '../common/testAIService.js';

suite('NexusAgentsEditor', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const project = URI.file('/home/user/My Project #1');

	test('the folder of a chat survives turning its resource into text and back', () => {
		const resource = URI.parse(nexusAgentsResource(project).toString(), true);
		assert.strictEqual(nexusAgentsFolder(resource)?.toString(), project.toString());
		assert.strictEqual(nexusAgentsFolder(nexusAgentsResource(undefined)), undefined);
		assert.strictEqual(nexusAgentsFolder(URI.file('/home/user/a.ts')), undefined, 'only Agents chat resources have a folder');
	});

	test('the chat is restored after a restart with its folder', () => {
		const serializer = new NexusAgentsEditorSerializer();
		const input = store.add(new NexusAgentsEditorInput(nexusAgentsResource(project)));
		const restored = serializer.deserialize(undefined!, serializer.serialize(input)!);
		assert.ok(restored instanceof NexusAgentsEditorInput);
		store.add(restored);
		assert.strictEqual(restored.folder?.toString(), project.toString());
		assert.ok(restored.matches(input));
		assert.strictEqual(serializer.deserialize(undefined!, URI.file('/x').toString()), undefined, 'other resources are not restored as a chat');

		const other = store.add(new NexusAgentsEditorInput(nexusAgentsResource(URI.file('/other'))));
		assert.ok(!other.matches(input), 'a chat for another folder is a different editor');
	});

	async function createPane(trustedFolders: readonly URI[]) {
		const instantiationService = workbenchInstantiationService(undefined, store);
		const aiService = store.add(new TestAIService());
		aiService.providers = [{ id: 'claude-cli', displayName: 'Claude Code CLI', kind: 'cli', available: true }];
		instantiationService.stub(IAIService, aiService);
		instantiationService.stub(IWorkspaceTrustManagementService, 'getUriTrustInfo', async (uri: URI): Promise<IWorkspaceTrustUriInfo> =>
			({ uri, trusted: trustedFolders.some(folder => folder.toString() === uri.toString()) }));

		const pane = store.add(instantiationService.createInstance(NexusAgentsEditorPane, new TestEditorGroupView(0)));
		const parent = document.createElement('div');
		document.body.appendChild(parent);
		store.add({ dispose: () => parent.remove() });
		pane.create(parent);

		const open = async (folder: URI | undefined) => {
			const input = store.add(new NexusAgentsEditorInput(nexusAgentsResource(folder)));
			await pane.setInput(input, undefined, {}, CancellationToken.None);
			await timeout(0);
		};
		const send = async (text: string) => {
			const input = parent.querySelector<HTMLTextAreaElement>('.nexus-chat-prompt')!;
			input.value = text;
			input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
			await timeout(0);
		};
		const banner = () => {
			const element = parent.querySelector<HTMLElement>('.nexus-chat-trust');
			return element?.style.display === 'none' ? undefined : { text: element?.textContent, hasTrustButton: !!element?.querySelector('.monaco-button') };
		};
		return { aiService, parent, open, send, banner };
	}

	test('the chat starts in Agent mode and works in the folder it was opened for', async () => {
		const { aiService, parent, open, send, banner } = await createPane([project]);
		await open(project);

		assert.strictEqual(parent.querySelector<HTMLSelectElement>('.nexus-chat-select')?.value, 'agent');
		assert.strictEqual(banner(), undefined, 'the folder is trusted');
		await send('clean up');
		assert.deepStrictEqual(aiService.requests.map(request => ({ mode: request.mode, workingDirectory: request.workingDirectory })), [
			{ mode: 'agent', workingDirectory: project.fsPath },
		]);
	});

	test('the chat sends nothing for a folder that is not trusted, and cannot trust it itself', async () => {
		const { aiService, open, send, banner } = await createPane([]);
		await open(project);

		const shown = banner();
		assert.ok(shown?.text?.includes(project.fsPath), shown?.text ?? '');
		assert.strictEqual(shown?.hasTrustButton, false, 'the folder is trusted in the IDE window, not here');
		await send('clean up');
		assert.strictEqual(aiService.requests.length, 0);
	});

	test('a chat for another folder starts fresh', async () => {
		const other = URI.file('/home/user/other');
		const { aiService, parent, open, send } = await createPane([project, other]);
		await open(project);
		await send('hi');
		aiService.hub.end(aiService.streamIds[0], 'completed');
		assert.strictEqual(parent.querySelectorAll('.nexus-chat-message').length, 2);

		await open(other);
		assert.strictEqual(parent.querySelectorAll('.nexus-chat').length, 1, 'the old chat is removed');
		assert.strictEqual(parent.querySelectorAll('.nexus-chat-message').length, 0);
		await send('hello');
		assert.strictEqual(aiService.requests.at(-1)?.workingDirectory, other.fsPath);
	});

	test('showing the chat opens it for the folder and hides the side bars and the panel', async () => {
		const opened: EditorInput[] = [];
		const hidden: string[] = [];
		const editorService = new class extends mock<IEditorService>() {
			override openEditor = (async (editor: EditorInput) => {
				opened.push(store.add(editor));
				return undefined;
			}) as IEditorService['openEditor'];
		};
		const layoutService = { setPartHidden: (isHidden: boolean, part: Parts) => isHidden && hidden.push(part) } as Partial<IWorkbenchLayoutService> as IWorkbenchLayoutService;

		await showNexusAgentsChat(editorService, layoutService, project);
		assert.deepStrictEqual(opened.map(editor => editor instanceof NexusAgentsEditorInput ? editor.folder?.toString() : 'other'), [project.toString()]);
		assert.deepStrictEqual(hidden, [Parts.SIDEBAR_PART, Parts.PANEL_PART, Parts.AUXILIARYBAR_PART]);
	});

	test('a window is an Agents window while it has an Agents chat open', () => {
		const editors: EditorInput[] = [];
		const onDidEditorsChange = store.add(new Emitter<IEditorsChangeEvent>());
		const editorService = new class extends mock<IEditorService>() {
			override get editors() { return editors; }
			override readonly onDidEditorsChange = onDidEditorsChange.event;
		};
		const contextKeyService = new MockContextKeyService();
		store.add(new NexusAgentsWindowContextContribution(editorService, contextKeyService as IContextKeyService));
		const inAgentsWindow = () => contextKeyService.getContextKeyValue(InNexusAgentsWindowContext.key);

		assert.strictEqual(inAgentsWindow(), false);
		editors.push(store.add(new NexusAgentsEditorInput(nexusAgentsResource(project))));
		onDidEditorsChange.fire({ groupId: 0, event: { kind: GroupModelChangeKind.EDITOR_OPEN } });
		assert.strictEqual(inAgentsWindow(), true);
		editors.length = 0;
		onDidEditorsChange.fire({ groupId: 0, event: { kind: GroupModelChangeKind.EDITOR_CLOSE } });
		assert.strictEqual(inAgentsWindow(), false);
	});
});
