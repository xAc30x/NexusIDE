/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NexusIDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { Event } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AIResult, IAIProviderInfo, IAIRunHandle, IAIService } from '../../../../../platform/ai/common/ai.js';
import { AIService } from '../../../../../platform/ai/common/aiService.js';
import { ECHO_PROVIDER_ID, EchoProvider } from '../../../../../platform/ai/common/echoProvider.js';
import { IStreamHubOptions } from '../../../../../platform/ai/common/streamHub.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { INexusChatMessage, LOST_TEXT_WARNING, NexusChatModel, pickProvider } from '../../common/nexusChatModel.js';
import { TestAIService } from './testAIService.js';

/** Lets pending promise callbacks settle. */
function settle(): Promise<void> {
	return timeout(0);
}

/** Message fields that tests compare; ids are random. */
function summarize(messages: readonly INexusChatMessage[]) {
	return messages.map(({ role, text, state, error, warning }) => ({ role, text, state, ...(error ? { error } : {}), ...(warning ? { warning } : {}) }));
}

suite('NexusChatModel', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createService(options?: Partial<IStreamHubOptions>): TestAIService {
		return store.add(new TestAIService(options));
	}

	function createModel(service: IAIService): NexusChatModel {
		return store.add(new NexusChatModel(service));
	}

	const ask = { mode: 'ask', providerId: 'test' } as const;

	test('a saved chat can be shown again, and a running reply is not replaced', async () => {
		const service = createService();
		const model = createModel(service);
		await model.send('hi', ask);
		assert.strictEqual(model.restore('saved-thread', [{ role: 'user', text: 'older' }]), false);
		assert.strictEqual(model.threadId !== 'saved-thread', true);

		service.hub.end(service.streamIds[0], 'completed');
		assert.strictEqual(model.restore('saved-thread', [{ role: 'user', text: 'older' }, { role: 'assistant', text: 'done' }]), true);
		assert.strictEqual(model.threadId, 'saved-thread');
		assert.deepStrictEqual(model.capture(), {
			threadId: 'saved-thread',
			messages: [{ role: 'user', text: 'older' }, { role: 'assistant', text: 'done' }],
		});
	});

	test('sends the prompt and streams the reply until it completes', async () => {
		const service = createService();
		const model = createModel(service);
		let changes = 0;
		store.add(model.onDidChange(() => changes++));

		assert.deepStrictEqual(await model.send('hi there', { mode: 'plan', providerId: 'test', workingDirectory: '/work' }), { ok: true, value: undefined });
		assert.deepStrictEqual(service.requests, [{ threadId: model.threadId, providerId: 'test', mode: 'plan', prompt: 'hi there', workingDirectory: '/work' }]);
		assert.strictEqual(model.isRunning, true);

		const streamId = service.streamIds[0];
		service.hub.appendText(streamId, 'Hel');
		service.hub.appendText(streamId, 'lo');
		assert.deepStrictEqual(summarize(model.messages), [
			{ role: 'user', text: 'hi there', state: 'completed' },
			{ role: 'assistant', text: 'Hello', state: 'streaming' },
		]);

		service.hub.end(streamId, 'completed');
		assert.strictEqual(model.isRunning, false);
		assert.deepStrictEqual(summarize(model.messages)[1], { role: 'assistant', text: 'Hello', state: 'completed' });
		assert.ok(changes >= 4, `expected change events, got ${changes}`);
	});

	test('recovers text that streamed before the stream id was known', async () => {
		const service = createService();
		service.sendResponse = async request => {
			const streamId = service.createStream();
			service.streamIds.push(streamId);
			service.hub.appendText(streamId, 'early ');
			return { ok: true, value: { threadId: request.threadId, streamId } };
		};
		const model = createModel(service);

		await model.send('hi', ask);
		service.hub.appendText(service.streamIds[0], 'late');
		service.hub.end(service.streamIds[0], 'completed');

		assert.deepStrictEqual(summarize(model.messages)[1], { role: 'assistant', text: 'early late', state: 'completed' });
	});

	test('skips chunks it has already applied', async () => {
		const service = createService();
		const model = createModel(service);
		await model.send('hi', ask);
		const streamId = service.streamIds[0];

		service.hub.appendText(streamId, 'a');
		service.fireDelta({ streamId, chunks: [{ kind: 'text', cursor: 0, text: 'a' }] });
		service.hub.appendText(streamId, 'b');

		assert.strictEqual(model.messages[1].text, 'ab');
	});

	test('reads missed chunks when an event skips ahead', async () => {
		const service = createService();
		const model = createModel(service);
		await model.send('hi', ask);
		const streamId = service.streamIds[0];

		service.deliverEvents = false;
		service.hub.appendText(streamId, 'a');
		service.hub.appendText(streamId, 'b');
		service.deliverEvents = true;
		service.hub.appendText(streamId, 'c');
		await settle();
		service.hub.end(streamId, 'completed');

		assert.deepStrictEqual(summarize(model.messages)[1], { role: 'assistant', text: 'abc', state: 'completed' });
	});

	test('warns when the start of a long reply was dropped from the buffer', async () => {
		const service = createService({ maxChunksPerStream: 2 });
		const model = createModel(service);
		await model.send('hi', ask);
		const streamId = service.streamIds[0];

		service.deliverEvents = false;
		service.hub.appendText(streamId, 'a');
		service.hub.appendText(streamId, 'b');
		service.hub.appendText(streamId, 'c');
		service.deliverEvents = true;
		service.hub.end(streamId, 'completed');
		await settle();

		assert.deepStrictEqual(summarize(model.messages)[1], { role: 'assistant', text: 'c', state: 'completed', warning: LOST_TEXT_WARNING });
	});

	test('fails the reply when the service refuses the request', async () => {
		const service = createService();
		service.sendResponse = async () => ({ ok: false, error: 'Provider Claude Code CLI is not available.' });
		const model = createModel(service);

		assert.deepStrictEqual(await model.send('hi', ask), { ok: true, value: undefined });
		assert.strictEqual(model.isRunning, false);
		assert.deepStrictEqual(summarize(model.messages)[1], { role: 'assistant', text: '', state: 'failed', error: 'Provider Claude Code CLI is not available.' });
	});

	test('fails the reply when the service cannot be reached', async () => {
		const service = createService();
		service.sendResponse = () => Promise.reject(new Error('Channel has been closed'));
		const model = createModel(service);

		await model.send('hi', ask);
		assert.deepStrictEqual(summarize(model.messages)[1], { role: 'assistant', text: '', state: 'failed', error: 'Channel has been closed' });
	});

	test('fails the reply when missed chunks cannot be read', async () => {
		const service = createService();
		const model = createModel(service);
		service.readResponse = async () => ({ ok: false, error: 'Unknown stream: x.' });

		await model.send('hi', ask);
		assert.deepStrictEqual(summarize(model.messages)[1], { role: 'assistant', text: '', state: 'failed', error: 'Could not read the reply: Unknown stream: x.' });
		assert.strictEqual(model.isRunning, false);
	});

	test('fails the reply when the service skips chunks while reading', async () => {
		const service = createService();
		const model = createModel(service);
		service.readResponse = async () => ({ ok: true, value: { streamId: 's', chunks: [{ kind: 'text', cursor: 5, text: 'x' }], nextCursor: 6, done: false, truncated: false } });

		await model.send('hi', ask);
		assert.strictEqual(model.messages[1].state, 'failed');
		assert.strictEqual(model.isRunning, false);
	});

	test('shows the error of a failed stream', async () => {
		const service = createService();
		const model = createModel(service);
		await model.send('hi', ask);

		service.hub.appendText(service.streamIds[0], 'partial');
		service.hub.end(service.streamIds[0], 'failed', 'Claude CLI exited with code 1.');

		assert.deepStrictEqual(summarize(model.messages)[1], { role: 'assistant', text: 'partial', state: 'failed', error: 'Claude CLI exited with code 1.' });
	});

	test('refuses an empty prompt and a second prompt while a reply runs', async () => {
		const service = createService();
		const model = createModel(service);

		assert.strictEqual((await model.send('  \n ', ask)).ok, false);
		assert.strictEqual(model.messages.length, 0);

		await model.send('first', ask);
		assert.strictEqual((await model.send('second', ask)).ok, false);
		assert.strictEqual(model.messages.length, 2);
		assert.strictEqual(service.requests.length, 1);
	});

	test('stop cancels the run and the reply ends as cancelled', async () => {
		const service = createService();
		const model = createModel(service);

		assert.deepStrictEqual(await model.stop(), { ok: true, value: false });
		assert.deepStrictEqual(service.cancelledThreads, []);

		await model.send('hi', ask);
		assert.deepStrictEqual(await model.stop(), { ok: true, value: true });
		assert.deepStrictEqual(service.cancelledThreads, [model.threadId]);
		assert.strictEqual(model.isRunning, true, 'the reply runs until the stream ends');

		service.hub.end(service.streamIds[0], 'cancelled');
		assert.strictEqual(model.isRunning, false);
		assert.strictEqual(model.messages[1].state, 'cancelled');
	});

	test('a new chat cancels the running reply and ignores its remaining output', async () => {
		const service = createService();
		const model = createModel(service);
		await model.send('hi', ask);
		const oldThreadId = model.threadId;
		const oldStreamId = service.streamIds[0];
		service.hub.appendText(oldStreamId, 'a');

		model.clear();
		assert.deepStrictEqual(model.messages, []);
		assert.strictEqual(model.isRunning, false);
		assert.notStrictEqual(model.threadId, oldThreadId);
		assert.deepStrictEqual(service.cancelledThreads, [oldThreadId]);

		service.hub.appendText(oldStreamId, 'b');
		service.hub.end(oldStreamId, 'cancelled');
		assert.deepStrictEqual(model.messages, []);

		await model.send('again', ask);
		assert.strictEqual(service.requests[1].threadId, model.threadId);
		assert.strictEqual(model.isRunning, true);
	});

	test('a new chat started while the request is being sent drops that reply', async () => {
		const service = createService();
		const pending = new DeferredPromise<AIResult<IAIRunHandle>>();
		service.sendResponse = () => pending.p;
		const model = createModel(service);

		const sent = model.send('hi', ask);
		model.clear();
		const streamId = service.createStream();
		service.hub.appendText(streamId, 'late');
		pending.complete({ ok: true, value: { threadId: 'old', streamId } });

		assert.deepStrictEqual(await sent, { ok: true, value: undefined });
		assert.deepStrictEqual(model.messages, []);
		assert.deepStrictEqual(service.readCursors, [], 'the dropped reply is not read');
	});

	test('disposing the model cancels the running reply', async () => {
		const service = createService();
		const model = new NexusChatModel(service);
		await model.send('hi', ask);
		const threadId = model.threadId;

		model.dispose();
		assert.deepStrictEqual(service.cancelledThreads, [threadId]);
	});

	suite('with the real AI service', () => {

		const echo = { mode: 'ask', providerId: ECHO_PROVIDER_ID } as const;

		function createRealService(delayMs: number): AIService {
			return store.add(new AIService([new EchoProvider(delayMs)], new NullLogService()));
		}

		/** Resolves once `condition` holds, checked after every change of the model. */
		function when(model: NexusChatModel, condition: () => boolean): Promise<unknown> {
			return condition() ? Promise.resolve() : Event.toPromise(Event.filter(model.onDidChange, condition));
		}

		function waitUntilIdle(model: NexusChatModel): Promise<unknown> {
			return when(model, () => !model.isRunning);
		}

		test('streams a complete reply', async () => {
			const model = store.add(new NexusChatModel(createRealService(0)));

			await model.send('hello from the chat panel', echo);
			await waitUntilIdle(model);

			assert.deepStrictEqual(summarize(model.messages), [
				{ role: 'user', text: 'hello from the chat panel', state: 'completed' },
				{ role: 'assistant', text: 'hello from the chat panel', state: 'completed' },
			]);
		});

		test('stops a reply and can send again in the same chat', async () => {
			const model = store.add(new NexusChatModel(createRealService(20)));

			await model.send('one two three four five six', echo);
			await when(model, () => model.messages[1].text.length > 0);
			assert.deepStrictEqual(await model.stop(), { ok: true, value: true });
			await waitUntilIdle(model);
			assert.strictEqual(model.messages[1].state, 'cancelled');
			assert.ok(model.messages[1].text.length < 'one two three four five six'.length, 'the reply stopped early');

			assert.deepStrictEqual(await model.send('again', echo), { ok: true, value: undefined });
			await waitUntilIdle(model);
			assert.deepStrictEqual(summarize(model.messages)[3], { role: 'assistant', text: 'again', state: 'completed' });
		});
	});

	test('keeps text, tool use and permission requests in order and sends answers', async () => {
		const service = createService();
		const model = createModel(service);
		await model.send('fix it', { mode: 'agent', providerId: 'test' });
		const streamId = service.streamIds[0];

		service.hub.appendText(streamId, 'Looking');
		service.hub.appendText(streamId, '...');
		service.hub.appendEvent(streamId, { kind: 'tool', summary: 'Read a.ts', failed: false });
		service.hub.appendEvent(streamId, { kind: 'permission', requestId: 'r1', toolName: 'Edit', summary: 'Edit a.ts', detail: '/w/a.ts' });
		service.hub.appendEvent(streamId, { kind: 'permission', requestId: 'r2', toolName: 'Bash', summary: 'Run: rm x' });

		assert.deepStrictEqual(await model.respondToPermission('r1', 'allow'), { ok: true, value: true });
		assert.deepStrictEqual(await model.respondToPermission('unknown', 'allow'), { ok: true, value: false });
		assert.deepStrictEqual(service.permissionAnswers, [{ threadId: model.threadId, requestId: 'r1', decision: 'allow' }]);

		service.hub.appendEvent(streamId, { kind: 'permissionResolved', requestId: 'r1', decision: 'allow' });
		service.hub.appendEvent(streamId, { kind: 'tool', summary: 'Edit a.ts', failed: false });
		service.hub.appendEvent(streamId, { kind: 'permissionResolved', requestId: 'r2', decision: 'deny' });
		service.hub.appendText(streamId, 'Done.');
		assert.deepStrictEqual(await model.respondToPermission('r2', 'allow'), { ok: true, value: false }, 'answered requests are not sent again');
		service.hub.end(streamId, 'completed');

		assert.deepStrictEqual(model.messages.map(({ text, parts }) => ({ text, parts })), [
			{ text: 'fix it', parts: [{ kind: 'text', text: 'fix it' }] },
			{
				text: 'Looking...Done.', parts: [
					{ kind: 'text', text: 'Looking...' },
					{ kind: 'tool', summary: 'Read a.ts', failed: false },
					{ kind: 'permission', requestId: 'r1', toolName: 'Edit', summary: 'Edit a.ts', detail: '/w/a.ts', state: 'allowed' },
					{ kind: 'permission', requestId: 'r2', toolName: 'Bash', summary: 'Run: rm x', state: 'denied' },
					{ kind: 'tool', summary: 'Edit a.ts', failed: false },
					{ kind: 'text', text: 'Done.' },
				]
			},
		]);
	});

	test('sends an attachment with the prompt but shows only its label', async () => {
		const service = createService();
		const model = createModel(service);
		await model.send('why does it fail?', { mode: 'debug', providerId: 'test', attachment: { label: 'Included 1 problem.', text: '<problems>\na.ts:1:1 error: boom\n</problems>' } });

		assert.strictEqual(service.requests[0].prompt, 'why does it fail?\n\n<problems>\na.ts:1:1 error: boom\n</problems>');
		assert.deepStrictEqual(model.messages.map(({ role, text, attachmentLabel }) => ({ role, text, attachmentLabel })), [
			{ role: 'user', text: 'why does it fail?', attachmentLabel: 'Included 1 problem.' },
			{ role: 'assistant', text: '', attachmentLabel: undefined },
		]);
	});

	test('picks the preferred provider when it is available, otherwise the first available one', () => {
		const info = (id: string, available: boolean): IAIProviderInfo => ({ id, displayName: id, kind: 'cli', available });
		const providers = [info('claude-cli', false), info('echo', true), info('other', true)];

		assert.strictEqual(pickProvider(providers, 'other')?.id, 'other');
		assert.strictEqual(pickProvider(providers, 'claude-cli')?.id, 'echo');
		assert.strictEqual(pickProvider(providers, undefined)?.id, 'echo');
		assert.strictEqual(pickProvider([info('claude-cli', false)], undefined), undefined);
	});
});
