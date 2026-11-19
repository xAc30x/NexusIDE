/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NexusIDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IAIService } from '../../../../../platform/ai/common/ai.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { TestDialogService } from '../../../../../platform/dialogs/test/common/testDialogService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IWorkspaceTrustManagementService, IWorkspaceTrustUriInfo } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IWorkbenchLayoutService, Parts } from '../../../../services/layout/browser/layoutService.js';
import { TestEditorGroupView, workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { createFileStat } from '../../../../test/common/workbenchTestServices.js';
import { INexusAgentsDocumentService, NexusAgentsDocumentService } from '../../browser/nexusAgentsDocumentService.js';
import { NexusAgentsEditorInput, NexusAgentsEditorPane, NexusAgentsEditorSerializer, nexusAgentsFolder, nexusAgentsResource, showNexusAgentsChat } from '../../browser/nexusAgentsEditor.js';
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
		const documents = store.add(instantiationService.createInstance(NexusAgentsDocumentService));
		instantiationService.stub(INexusAgentsDocumentService, documents);

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
		return { aiService, parent, open, send, banner, documents, instantiationService };
	}

	test('the chat starts in Agent mode and works in the folder it was opened for', async () => {
		const { aiService, parent, open, send, banner, documents } = await createPane([project]);
		await open(project);

		assert.strictEqual(parent.querySelector<HTMLSelectElement>('.nexus-chat-select')?.value, 'agent');
		assert.strictEqual(banner(), undefined, 'the folder is trusted');
		await send('clean up');
		assert.deepStrictEqual(aiService.requests.map(request => ({ mode: request.mode, workingDirectory: request.workingDirectory })), [
			{ mode: 'agent', workingDirectory: project.fsPath },
		]);
		assert.ok(documents.snapshot.conversations.some(conversation => conversation.origin === 'agents' && conversation.messages.some(message => message.text === 'clean up')));
		assert.strictEqual(parent.querySelector('.nexus-agents-customize')?.textContent, 'Customize is not available yet.');
		assert.strictEqual(parent.querySelector('.nexus-agents-project'), null, 'Projects appear after sign-in');
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

	async function until(check: () => boolean): Promise<void> {
		for (let attempt = 0; attempt < 20 && !check(); attempt++) {
			await timeout(0);
		}
	}

	test('a follow-up waits for the turn, and Ctrl+Enter is sent ahead of it when the turn ends', async () => {
		const { aiService, parent, open, send } = await createPane([project]);
		await open(project);
		await send('first');
		const input = parent.querySelector<HTMLTextAreaElement>('.nexus-chat-prompt')!;
		const press = (text: string, ctrl: boolean) => {
			input.value = text;
			input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ctrlKey: ctrl }));
		};
		press('later', false);
		press('now', true);
		assert.strictEqual(aiService.requests.length, 1, 'both wait while the turn is running');

		aiService.hub.end(aiService.streamIds[0], 'completed');
		await until(() => aiService.requests.length === 2);
		assert.strictEqual(aiService.requests[1].prompt, 'now');

		aiService.hub.end(aiService.streamIds[1], 'completed');
		await until(() => aiService.requests.length === 3);
		assert.strictEqual(aiService.requests[2].prompt, 'later');
	});

	test('the Agents window trusts a folder after the standard warning, then opens its files and a terminal', async () => {
		const { parent, open, instantiationService, documents } = await createPane([]);
		await open(project);
		const trustButton = parent.querySelector<HTMLButtonElement>('.nexus-agents-trust');
		assert.ok(trustButton);
		assert.strictEqual(parent.querySelector('.nexus-chat-trust .monaco-button'), null, 'the chat banner is not a second trust control');

		const dialog = instantiationService.get(IDialogService) as TestDialogService;
		const trust = instantiationService.get(IWorkspaceTrustManagementService);
		const trusted: URI[] = [];
		trust.setUrisTrust = async (uris: URI[], value: boolean) => {
			if (value) {
				trusted.push(...uris);
			}
		};
		dialog.setConfirmResult({ confirmed: false });
		trustButton.click();
		await timeout(0);
		assert.strictEqual(trusted.length, 0);

		dialog.setConfirmResult({ confirmed: true });
		trustButton.click();
		await until(() => trusted.length === 1);
		assert.strictEqual(trusted[0].toString(), project.toString());

		const file = URI.joinPath(project, 'a.ts');
		const fileService = instantiationService.get(IFileService);
		fileService.resolve = (async (resource: URI) => createFileStat(resource, false, false, true, false, [{ resource: file, isFile: true }])) as IFileService['resolve'];
		parent.querySelector<HTMLButtonElement>('.nexus-agents-files-button')!.click();
		await until(() => !!parent.querySelector('.nexus-agents-file'));
		const opened: URI[] = [];
		const editorService = instantiationService.get(IEditorService);
		editorService.openEditor = (async (editor: { resource?: URI }) => {
			if (editor.resource) {
				opened.push(editor.resource);
			}
			return undefined;
		}) as IEditorService['openEditor'];
		parent.querySelector<HTMLButtonElement>('.nexus-agents-file')!.click();
		assert.strictEqual(opened[0]?.toString(), file.toString());

		const terminals: URI[] = [];
		documents.setTerminalOpener(async folder => { terminals.push(folder); });
		parent.querySelector<HTMLButtonElement>('.nexus-agents-terminal')!.click();
		await until(() => terminals.length === 1);
		assert.strictEqual(terminals[0].toString(), project.toString());
	});

	test('signing in shows Projects, and a message hands the work to an agent on its own branch', async () => {
		const { parent, documents } = await createPane([project]);
		parent.querySelector<HTMLButtonElement>('.nexus-agents-sign-in')!.click();
		parent.querySelector<HTMLButtonElement>('.nexus-agents-github')!.click();
		const form = parent.querySelector<HTMLFormElement>('.nexus-agents-new-project')!;
		const inputs = form.querySelectorAll('input');
		inputs[0].value = 'Migration';
		inputs[1].value = 'acme/app';
		inputs[2].value = 'opus';
		form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

		assert.strictEqual(documents.snapshot.projects[0]?.repository, 'acme/app');
		parent.querySelector<HTMLButtonElement>('.nexus-agents-project')!.click();
		const prompt = parent.querySelector<HTMLTextAreaElement>('.nexus-agents-project-prompt')!;
		prompt.value = 'Move the parser';
		parent.querySelector<HTMLButtonElement>('.nexus-agents-message-project')!.click();
		const agent = documents.snapshot.projects[0].agents[0];
		assert.strictEqual(agent.prompt, 'Move the parser');
		assert.strictEqual(agent.branch, `nexus/${agent.id}`);
		assert.strictEqual(agent.baseBranch, 'main');
		assert.strictEqual(agent.status, 'running');
		assert.strictEqual(parent.querySelector('.nexus-agents-automation'), null);
	});

	test('an Automation keeps its webhook and the MCP server added to it', async () => {
		const { parent, documents } = await createPane([project]);
		parent.querySelector<HTMLButtonElement>('.nexus-agents-sign-in')!.click();
		parent.querySelector<HTMLButtonElement>('.nexus-agents-slack')!.click();
		const form = parent.querySelector<HTMLFormElement>('.nexus-agents-new-automation')!;
		const inputs = form.querySelectorAll('input');
		inputs[0].value = 'Review';
		inputs[1].value = 'opus';
		inputs[2].value = 'Look at the pull request';
		inputs[3].value = 'acme/app';
		inputs[5].value = 'https://mcp.example/rpc';
		inputs[6].value = 'secret';
		form.querySelector('select')!.value = 'webhook';
		form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

		const automation = documents.snapshot.automations[0];
		assert.strictEqual(automation.name, 'Review');
		assert.ok(automation.webhook?.url.startsWith('https://hooks.nexuside.local/'));
		assert.ok(automation.webhook?.key);
		assert.deepStrictEqual(automation.mcp, [{ url: 'https://mcp.example/rpc', credential: 'secret' }]);
		assert.strictEqual(automation.repositories[0], 'acme/app');
		assert.strictEqual(parent.querySelector('.nexus-agents-automation')?.textContent, 'Review');
	});

});
