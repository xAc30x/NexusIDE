/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NexusIDE contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../base/common/async.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ChannelClient, ChannelServer, IMessagePassingProtocol, ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { AIResult, AIStreamChunk, IAIMessageRequest, IAIService, IAIStreamDelta } from '../../common/ai.js';
import { IAIProviderAdapter } from '../../common/aiProvider.js';
import { AIService } from '../../common/aiService.js';
import { EchoProvider } from '../../common/echoProvider.js';

function unwrap<T>(result: AIResult<T>): T {
	if (!result.ok) {
		assert.fail(`Expected ok result, got error: ${result.error}`);
	}
	return result.value;
}

/** Lets pending promise callbacks (such as a finished provider run) settle. */
function settle(): Promise<void> {
	return timeout(0);
}

/**
 * Provider whose runs are completed or failed by the test. `emit` writes to
 * the most recent run; `complete` and `fail` settle every outstanding run.
 */
class ManualProvider implements IAIProviderAdapter {

	readonly displayName = 'Manual';
	readonly kind = 'http' as const;

	available: boolean | Error = true;
	runCount = 0;
	lastToken: CancellationToken | undefined;
	private onText: ((text: string) => void) | undefined;
	private pending: DeferredPromise<void>[] = [];

	constructor(readonly id = 'manual') { }

	async isAvailable(): Promise<boolean> {
		if (this.available instanceof Error) {
			throw this.available;
		}
		return this.available;
	}

	run(_request: IAIMessageRequest, onText: (text: string) => void, token: CancellationToken): Promise<void> {
		this.runCount++;
		this.onText = onText;
		this.lastToken = token;
		const deferred = new DeferredPromise<void>();
		this.pending.push(deferred);
		return deferred.p;
	}

	emit(text: string): void {
		this.onText?.(text);
	}

	complete(): void {
		for (const deferred of this.pending.splice(0)) {
			deferred.complete();
		}
	}

	fail(error: Error): void {
		for (const deferred of this.pending.splice(0)) {
			deferred.error(error);
		}
	}
}

function request(overrides: Partial<IAIMessageRequest> = {}): IAIMessageRequest {
	return { threadId: 'thread-1', providerId: 'manual', mode: 'ask', prompt: 'hello', ...overrides };
}

async function readChunks(service: IAIService, streamId: string): Promise<readonly AIStreamChunk[]> {
	return unwrap(await service.readStream(streamId, 0)).chunks;
}

suite('AIService', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createService(...providers: IAIProviderAdapter[]): AIService {
		return store.add(new AIService(providers, new NullLogService()));
	}

	test('lists providers with their availability', async () => {
		const available = new ManualProvider('a');
		const unavailable = new ManualProvider('b');
		unavailable.available = false;
		const broken = new ManualProvider('c');
		broken.available = new Error('keychain locked');
		const service = createService(available, unavailable, broken);

		assert.deepStrictEqual(unwrap(await service.listProviders()), [
			{ id: 'a', displayName: 'Manual', kind: 'http', available: true },
			{ id: 'b', displayName: 'Manual', kind: 'http', available: false },
			{ id: 'c', displayName: 'Manual', kind: 'http', available: false },
		]);
	});

	test('streams provider text and ends the stream as completed', async () => {
		const provider = new ManualProvider();
		const service = createService(provider);

		const handle = unwrap(await service.sendMessage(request()));
		assert.strictEqual(handle.threadId, 'thread-1');

		provider.emit('Hi ');
		provider.emit('there');
		provider.complete();
		await settle();

		assert.deepStrictEqual(await readChunks(service, handle.streamId), [
			{ kind: 'text', cursor: 0, text: 'Hi ' },
			{ kind: 'text', cursor: 1, text: 'there' },
			{ kind: 'end', cursor: 2, reason: 'completed' },
		]);
	});

	test('fires stream events for every chunk', async () => {
		const provider = new ManualProvider();
		const service = createService(provider);
		const deltas: IAIStreamDelta[] = [];
		store.add(service.onDidStreamDelta(e => deltas.push(e)));

		const { streamId } = unwrap(await service.sendMessage(request()));
		provider.emit('a');
		provider.complete();
		await settle();

		assert.deepStrictEqual(deltas, [
			{ streamId, chunks: [{ kind: 'text', cursor: 0, text: 'a' }] },
			{ streamId, chunks: [{ kind: 'end', cursor: 1, reason: 'completed' }] },
		]);
	});

	test('allows one run per thread and releases the thread when the run ends', async () => {
		const provider = new ManualProvider();
		const service = createService(provider);

		unwrap(await service.sendMessage(request()));
		assert.strictEqual((await service.sendMessage(request())).ok, false);
		unwrap(await service.sendMessage(request({ threadId: 'thread-2' })));

		provider.complete();
		await settle();

		unwrap(await service.sendMessage(request()));
		provider.complete();
		await settle();
	});

	test('cancelRun cancels the provider and ends the stream as cancelled', async () => {
		const provider = new ManualProvider();
		const service = createService(provider);
		const { streamId } = unwrap(await service.sendMessage(request()));

		assert.deepStrictEqual(await service.cancelRun('thread-1'), { ok: true, value: true });
		assert.strictEqual(provider.lastToken?.isCancellationRequested, true);

		// The thread stays locked until the provider has stopped.
		assert.strictEqual((await service.sendMessage(request())).ok, false);

		provider.complete();
		await settle();

		assert.deepStrictEqual(await readChunks(service, streamId), [{ kind: 'end', cursor: 0, reason: 'cancelled' }]);
		unwrap(await service.sendMessage(request()));
		provider.complete();
		await settle();
	});

	test('cancelRun returns false when the thread has no active run', async () => {
		const service = createService(new ManualProvider());
		assert.deepStrictEqual(await service.cancelRun('thread-1'), { ok: true, value: false });
	});

	test('a failing provider ends the stream as failed and releases the thread', async () => {
		const provider = new ManualProvider();
		const service = createService(provider);
		const { streamId } = unwrap(await service.sendMessage(request()));

		provider.emit('partial');
		provider.fail(new Error('process exited with code 1'));
		await settle();

		assert.deepStrictEqual(await readChunks(service, streamId), [
			{ kind: 'text', cursor: 0, text: 'partial' },
			{ kind: 'end', cursor: 1, reason: 'failed', error: 'process exited with code 1' },
		]);
		unwrap(await service.sendMessage(request()));
		provider.complete();
		await settle();
	});

	test('rejects invalid requests without starting a run', async () => {
		const provider = new ManualProvider();
		const service = createService(provider);
		const invalid: unknown[] = [
			null,
			request({ threadId: '' }),
			request({ providerId: '' }),
			request({ providerId: 'missing' }),
			{ ...request(), mode: 'unknown' },
			request({ prompt: '' }),
			request({ prompt: '   ' }),
			request({ model: '' }),
			{ ...request(), threadId: 42 },
		];

		for (const value of invalid) {
			const result = await service.sendMessage(value as IAIMessageRequest);
			assert.strictEqual(result.ok, false, `expected rejection for ${JSON.stringify(value)}`);
		}
		assert.strictEqual(provider.runCount, 0);
	});

	test('rejects requests for an unavailable provider', async () => {
		const provider = new ManualProvider();
		provider.available = false;
		const service = createService(provider);

		assert.strictEqual((await service.sendMessage(request())).ok, false);
		assert.strictEqual(provider.runCount, 0);
	});

	test('validates readStream and cancelRun arguments', async () => {
		const service = createService(new ManualProvider());

		assert.strictEqual((await service.readStream('', 0)).ok, false);
		assert.strictEqual((await service.readStream('missing', 0)).ok, false);
		assert.strictEqual((await service.readStream('missing', '0' as unknown as number)).ok, false);
		assert.strictEqual((await service.cancelRun('')).ok, false);
	});

	test('rejects duplicate provider ids', () => {
		assert.throws(() => new AIService([new ManualProvider('x'), new ManualProvider('x')], new NullLogService()));
	});

	test('echo provider streams the prompt back', async () => {
		const service = createService(new EchoProvider(0));
		const { streamId } = unwrap(await service.sendMessage(request({ providerId: 'echo', prompt: 'one two  three' })));
		await settle();

		const chunks = await readChunks(service, streamId);
		const text = chunks.map(c => c.kind === 'text' ? c.text : '').join('');
		assert.strictEqual(text, 'one two  three');
		assert.deepStrictEqual(chunks.at(-1), { kind: 'end', cursor: chunks.length - 1, reason: 'completed' });
	});

	test('works over an IPC channel', async () => {
		const disposables = store.add(new DisposableStore());
		const provider = new ManualProvider();
		const service = createService(provider);

		const [serverProtocol, clientProtocol] = createProtocolPair(disposables);
		const server = disposables.add(new ChannelServer(serverProtocol, 'test'));
		server.registerChannel('ai', ProxyChannel.fromService(service, disposables, { unbufferedEvents: ['onDidStreamDelta'] }));
		const client = disposables.add(new ChannelClient(clientProtocol));
		const remote = ProxyChannel.toService<IAIService>(client.getChannel('ai'));

		const deltas: IAIStreamDelta[] = [];
		disposables.add(remote.onDidStreamDelta(e => deltas.push(e)));

		assert.deepStrictEqual(unwrap(await remote.listProviders()).map(p => p.id), ['manual']);
		const { streamId } = unwrap(await remote.sendMessage(request()));
		provider.emit('over ipc');
		provider.complete();

		const end = await Event.toPromise(Event.filter(remote.onDidStreamDelta, e => e.chunks.some(c => c.kind === 'end')), disposables);
		assert.strictEqual(end.streamId, streamId);
		assert.deepStrictEqual(deltas.flatMap(d => d.chunks), [
			{ kind: 'text', cursor: 0, text: 'over ipc' },
			{ kind: 'end', cursor: 1, reason: 'completed' },
		]);
		assert.deepStrictEqual(await readChunks(remote, streamId), deltas.flatMap(d => d.chunks));
		assert.deepStrictEqual(await remote.cancelRun('thread-1'), { ok: true, value: false });
	});
});

/**
 * In-memory message channel between an IPC server and client.
 */
class QueueProtocol implements IMessagePassingProtocol {

	private buffering = true;
	private buffers: VSBuffer[] = [];
	other!: QueueProtocol;

	private readonly _onMessage: Emitter<VSBuffer> = new Emitter<VSBuffer>({
		onDidAddFirstListener: () => {
			for (const buffer of this.buffers) {
				this._onMessage.fire(buffer);
			}
			this.buffers = [];
			this.buffering = false;
		},
		onDidRemoveLastListener: () => {
			this.buffering = true;
		}
	});

	readonly onMessage = this._onMessage.event;

	send(buffer: VSBuffer): void {
		this.other.receive(buffer);
	}

	dispose(): void {
		this._onMessage.dispose();
	}

	private receive(buffer: VSBuffer): void {
		if (this.buffering) {
			this.buffers.push(buffer);
		} else {
			this._onMessage.fire(buffer);
		}
	}
}

function createProtocolPair(disposables: DisposableStore): [IMessagePassingProtocol, IMessagePassingProtocol] {
	const one = disposables.add(new QueueProtocol());
	const other = disposables.add(new QueueProtocol());
	one.other = other;
	other.other = one;
	return [one, other];
}
