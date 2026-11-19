/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NexusIDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { automationMatches, connectGitHub, connectSlack, consumePendingReview, createAutomation, createProject, emptyNexusAgentsDocument, ensureLocalConversation, finishAutomationRun, finishProjectAgent, finishTurn, folderRows, followUp, messageProject, moveConversation, parseNexusAgentsDocument, rememberClone, resolveIdeTarget, saveTranscript, setAlwaysCreatePullRequests, setReachable, signIn, startLocalConversation, toolBoundary, visibleAutomations, visibleProjects } from '../../common/nexusAgentsDocument.js';

suite('NexusAgentsDocument', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const folder = URI.file('/home/user/project').toString();

	function signedIn() {
		const signed = signIn(emptyNexusAgentsDocument());
		assert.ok(signed.ok);
		const github = connectGitHub(signed.document);
		assert.ok(github.ok);
		const slack = connectSlack(github.document);
		assert.ok(slack.ok);
		return slack.document;
	}

	function localConversation() {
		return startLocalConversation(emptyNexusAgentsDocument(), folder, 'c1', 'thread-1');
	}

	test('a folder appears when a conversation starts, and a second one does not add the folder again', () => {
		const started = startLocalConversation(emptyNexusAgentsDocument(), folder, 'c1', 'thread-1');
		assert.deepStrictEqual(folderRows(started).map(row => row.folder), [folder]);
		const again = ensureLocalConversation(started, folder, 'c2', 'thread-2');
		assert.strictEqual(again.conversations.length, 1);
		assert.deepStrictEqual(again.selection, { kind: 'conversation', id: 'c1' });
	});

	test('a sidebar transcript is dropped when the document is read back', () => {
		const saved = JSON.parse(JSON.stringify(localConversation())) as { conversations: { origin: string }[] };
		saved.conversations.push({ origin: 'sidebar', id: 'side', runtime: 'local', folder } as { origin: string });
		const read = parseNexusAgentsDocument(JSON.stringify(saved));
		assert.deepStrictEqual(read.conversations.map(conversation => conversation.id), ['c1']);
	});

	test('signed out, local conversations stay and Projects and Automations do not appear', () => {
		const account = signedIn();
		const created = createProject(account, 'p1', 'Migration', 'acme/app', 'opus');
		assert.ok(created.ok);
		const hidden = { ...created.document, signedIn: false };
		assert.strictEqual(visibleProjects(hidden).length, 0);
		assert.strictEqual(visibleAutomations(hidden).length, 0);
		const local = startLocalConversation(hidden, folder, 'c1', 'thread-1');
		assert.strictEqual(folderRows(local).length, 1);
	});

	test('moving to the service needs a GitHub repository, keeps the transcript, and leaves local edits here', () => {
		let document = saveTranscript(localConversation(), 'c1', 'thread-1', [{ role: 'user', text: 'hello' }], false, false);
		const refused = moveConversation(document, 'c1', 'remote');
		assert.strictEqual(refused.ok, false);

		document = saveTranscript(document, 'c1', 'thread-1', [{ role: 'user', text: 'hello' }], true, false);
		assert.strictEqual(moveConversation(document, 'c1', 'remote', { githubRepository: 'acme/app' }).ok, false, 'a running turn cannot move');

		document = saveTranscript(document, 'c1', 'thread-1', [{ role: 'user', text: 'hello' }], false, false);
		const moved = moveConversation(document, 'c1', 'remote', { githubRepository: 'acme/app', defaultBranch: 'develop' });
		assert.ok(moved.ok);
		const conversation = moved.document.conversations[0];
		assert.strictEqual(conversation.runtime, 'remote');
		assert.strictEqual(conversation.branch, 'nexus/c1');
		assert.strictEqual(conversation.baseBranch, 'develop');
		assert.strictEqual(conversation.leftLocalChanges, true);
		assert.deepStrictEqual(conversation.messages, [{ role: 'user', text: 'hello' }]);

		assert.strictEqual(moveConversation(moved.document, 'c1', 'local').ok, false);
		const back = moveConversation(moved.document, 'c1', 'local', { localCheckout: true });
		assert.ok(back.ok);
		assert.strictEqual(back.document.conversations[0].runtime, 'local');
		assert.deepStrictEqual(back.document.conversations[0].messages, [{ role: 'user', text: 'hello' }]);
	});

	test('a follow-up waits for the turn, a steer is released at the tool boundary, and an approval holds the steer', () => {
		let document = saveTranscript(localConversation(), 'c1', 'thread-1', [], true, false);
		const queued = followUp(document, 'c1', 'after', 'queue');
		assert.ok(queued.ok);
		const steered = followUp(queued.document, 'c1', 'now', 'steer');
		assert.ok(steered.ok);
		assert.deepStrictEqual(steered.document.conversations[0].queued, ['after']);
		assert.strictEqual(steered.document.conversations[0].steer, 'now');

		const held = saveTranscript(steered.document, 'c1', 'thread-1', [], true, true);
		assert.strictEqual(toolBoundary(held, 'c1').steer, undefined, 'the approval is part of the turn');

		const released = toolBoundary(saveTranscript(steered.document, 'c1', 'thread-1', [], true, false), 'c1');
		assert.strictEqual(released.steer, 'now');
		assert.deepStrictEqual(released.document.conversations[0].messages.map(message => message.text), ['now']);

		const finished = finishTurn(held, 'c1');
		assert.deepStrictEqual(finished.conversations[0].messages.map(message => message.text), ['now', 'after']);
		assert.strictEqual(finished.conversations[0].running, false);
	});

	test('while the service is unreachable, a message to a remote conversation waits and is sent when it returns', () => {
		const moved = moveConversation(localConversation(), 'c1', 'remote', { githubRepository: 'acme/app' });
		assert.ok(moved.ok);
		const offline = setReachable(moved.document, false);
		const waiting = followUp(offline, 'c1', 'keep going', 'queue');
		assert.ok(waiting.ok);
		assert.deepStrictEqual(waiting.document.outbox, [{ conversationId: 'c1', text: 'keep going' }]);
		assert.strictEqual(createProject(waiting.document, 'p1', 'Migration', 'acme/app', 'opus').ok, false);
		assert.strictEqual(connectGitHub(waiting.document).ok, false);

		const online = setReachable(waiting.document, true);
		assert.deepStrictEqual(online.outbox, []);
		assert.deepStrictEqual(online.conversations[0].messages.map(message => message.text), ['keep going']);
	});

	test('a Project hands work to an agent on its own branch and opens a pull request unless the account says not to', () => {
		const account = signedIn();
		const created = createProject(account, 'p1', 'Migration', 'acme/app', 'opus');
		assert.ok(created.ok);
		const sent = messageProject(created.document, 'p1', 'a1', 'Move the parser', 'main');
		assert.ok(sent.ok);
		assert.strictEqual(sent.value.prompt, 'Move the parser');
		assert.strictEqual(sent.value.branch, 'nexus/a1');
		assert.strictEqual(sent.value.status, 'running');
		assert.deepStrictEqual(sent.document.selection, { kind: 'agent', projectId: 'p1', agentId: 'a1' });

		const finished = finishProjectAgent(sent.document, 'p1', 'a1');
		assert.ok(finished.ok);
		const agent = finished.document.projects[0].agents[0];
		assert.strictEqual(agent.status, 'finished');
		assert.ok(agent.pullRequestUrl?.startsWith('https://github.com/acme/app/pull/1'));

		const quiet = setAlwaysCreatePullRequests(sent.document, false);
		const without = finishProjectAgent(quiet, 'p1', 'a1');
		assert.ok(without.ok);
		assert.strictEqual(without.document.projects[0].agents[0].pullRequestUrl, undefined);
	});

	test('an Automation accepts Cursor triggers, refuses a GitHub event with no repository, and ignores fork pull requests except merges', () => {
		const account = signedIn();
		const missingRepo = createAutomation(account, {
			id: 'auto',
			name: 'Review',
			prompt: 'Look at the pull request',
			model: 'opus',
			triggers: [{ kind: 'github', event: 'pull_request_opened' }],
			repositories: [],
			webhookKey: 'key',
		});
		assert.strictEqual(missingRepo.ok, false);

		const created = createAutomation(account, {
			id: 'auto',
			name: 'Review',
			prompt: 'Look',
			model: 'opus',
			triggers: [
				{ kind: 'github', event: 'pull_request_opened' },
				{ kind: 'github', event: 'pull_request_merged' },
				{ kind: 'slack', event: 'message' },
				{ kind: 'schedule', cron: '0 8 * * *' },
				{ kind: 'webhook' },
			],
			repositories: ['acme/app', 'acme/web'],
			mcp: [{ url: 'https://mcp.example/rpc', credential: 'secret' }],
			webhookKey: 'key',
		});
		assert.ok(created.ok);
		assert.strictEqual(created.value.webhook?.url, 'https://hooks.nexuside.local/auto');
		assert.strictEqual(created.value.webhook?.key, 'key');
		assert.strictEqual(created.value.mcp[0].credential, 'secret');

		const automation = created.value;
		assert.strictEqual(automationMatches(automation, { source: 'github', event: 'pull_request_opened', repository: 'acme/app', fromFork: true }), false);
		assert.strictEqual(automationMatches(automation, { source: 'github', event: 'pull_request_merged', repository: 'acme/app', fromFork: true }), true);
		assert.strictEqual(automationMatches(automation, { source: 'github', event: 'pull_request_opened', repository: 'other/app', fromFork: false }), false);
		assert.strictEqual(automationMatches(automation, { source: 'slack', event: 'message', publicChannel: false }), false);
		assert.strictEqual(automationMatches(automation, { source: 'slack', event: 'message', publicChannel: true, threaded: true }), false);
		assert.strictEqual(automationMatches(automation, { source: 'slack', event: 'message', publicChannel: true }), true);
		assert.strictEqual(automationMatches(automation, { source: 'schedule', cron: '0 8 * * *' }), true);
		assert.strictEqual(automationMatches(automation, { source: 'webhook', automationId: 'auto' }), true);

		const run = finishAutomationRun(created.document, 'auto', 'run-1');
		assert.ok(run.ok);
		assert.ok(run.document.automations[0].runs[0].pullRequestUrl);
		assert.strictEqual(run.document.projects.length, 0, 'MCP stays on the Automation');
	});

	test('IDE opens the selected folder, clones a Project that is not on disk, and reviews an agent without checking out its branch', () => {
		assert.deepStrictEqual(resolveIdeTarget(emptyNexusAgentsDocument()), { kind: 'none' });

		const local = localConversation();
		assert.deepStrictEqual(resolveIdeTarget(local), { kind: 'open', folder });

		const account = signedIn();
		const created = createProject(account, 'p1', 'Migration', 'acme/app', 'opus');
		assert.ok(created.ok);
		assert.deepStrictEqual(resolveIdeTarget(created.document), { kind: 'clone', repository: 'acme/app' });

		const cloned = rememberClone(created.document, 'acme/app', URI.file('/clones'));
		assert.strictEqual(cloned.clones['acme/app'], URI.file('/clones/app').toString());
		assert.deepStrictEqual(resolveIdeTarget(cloned), { kind: 'open', folder: URI.file('/clones/app').toString() });

		const sent = messageProject(cloned, 'p1', 'a1', 'Review the branch');
		assert.ok(sent.ok);
		const finished = finishProjectAgent(sent.document, 'p1', 'a1');
		assert.ok(finished.ok);
		const target = resolveIdeTarget(finished.document);
		assert.strictEqual(target.kind, 'open');
		if (target.kind === 'open') {
			assert.deepStrictEqual(target.review, { base: 'main', branch: 'nexus/a1', checkout: false });
		}

		const automation = createAutomation(account, {
			id: 'auto',
			name: 'Ping',
			prompt: 'Say hello',
			model: 'opus',
			triggers: [{ kind: 'slack', event: 'message' }],
			repositories: [],
			webhookKey: 'key',
		});
		assert.ok(automation.ok);
		assert.deepStrictEqual(resolveIdeTarget(automation.document), { kind: 'none' });
	});

	test('a review is shown once and does not stay on the document', () => {
		const document = { ...emptyNexusAgentsDocument(), pendingReview: { folder, base: 'main', branch: 'nexus/a1' } };
		const consumed = consumePendingReview(document, folder);
		assert.deepStrictEqual(consumed.review, { base: 'main', branch: 'nexus/a1', checkout: false });
		assert.strictEqual(consumed.document.pendingReview, undefined);
	});

	test('several local conversations in one folder can be running together', () => {
		let document = startLocalConversation(emptyNexusAgentsDocument(), folder, 'c1', 't1');
		document = startLocalConversation(document, folder, 'c2', 't2');
		document = saveTranscript(document, 'c1', 't1', [], true, true);
		document = saveTranscript(document, 'c2', 't2', [], true, false);
		assert.strictEqual(document.conversations.filter(conversation => conversation.running).length, 2);
		assert.strictEqual(folderRows(document)[0].conversations.length, 2);
	});
});
