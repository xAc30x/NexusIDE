/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { cacheDirectory } from '../../node/instantGrep/instantGrepGit.js';
import { InstantGrepHost, dispatchInstantGrep, type IInstantGrepRequest } from '../../node/instantGrep/instantGrepHost.js';
import { buildAll, buildCovering } from '../../node/instantGrep/instantGrepNgrams.js';

suite('Instant Grep', function () {
	ensureNoDisposablesAreLeakedInTestSuite();
	this.timeout(20000);

	const root = mkdtempSync(join(tmpdir(), 'instant-grep-'));
	suiteTeardown(() => rmSync(root, { recursive: true, force: true }));

	test('exact and regex needles resolve through the one host path', async () => {
		const repo = createRepo('needles');
		writeFileSync(join(repo, 'src', 'pay.ts'), 'import { PaymentService } from \'./payment\';\nexport class PaymentService {}\n');
		commit(repo, 'pay');
		const host = new InstantGrepHost({ watch: false });
		const exact = await dispatchInstantGrep(host, request(repo, 'grep', 'PaymentService'));
		const regex = await dispatchInstantGrep(host, request(repo, 'grep', 'import.*PaymentService'));
		assert.strictEqual(exact.source, 'index');
		assert.strictEqual(regex.source, 'index');
		assert.ok(exact.text.includes('src/pay.ts'));
		assert.ok(exact.text.includes('PaymentService'));
		assert.ok(regex.text.includes('src/pay.ts'));
		assert.ok(regex.text.includes('import { PaymentService }'));
		const miss = await dispatchInstantGrep(host, request(repo, 'grep', 'this-needle-is-absent'));
		assert.strictEqual(miss.source, 'index');
		assert.strictEqual(miss.text, 'No matches found.');
		host.dispose();
	});

	test('a covering gram of a literal is produced from a file that contains it', () => {
		const literal = 'PaymentService';
		const covering = buildCovering(literal);
		const produced = new Set(buildAll(`import { ${literal} } from './payment';\n`).map(gram => gram.text));
		assert.ok(covering.length > 0);
		for (const gram of covering) {
			assert.ok(produced.has(gram.text), gram.text);
		}
	});

	test('an ignored path is absent and a nexusignore negation brings it back', async () => {
		const repo = createRepo('ignore');
		writeFileSync(join(repo, 'src', 'pay.ts'), 'export const keep = 1;\n');
		commit(repo, 'keep');
		mkdirSync(join(repo, 'node_modules'));
		writeFileSync(join(repo, 'node_modules', 'hidden.ts'), 'export const HIDDEN_NEEDLE = 1;\n');
		writeFileSync(join(repo, 'secret.txt'), 'export const SECRET_NEEDLE = 1;\n');
		writeFileSync(join(repo, '.gitignore'), 'secret.txt\nnode_modules/\n');
		const host = new InstantGrepHost({ watch: false });
		const hidden = await dispatchInstantGrep(host, request(repo, 'grep', 'HIDDEN_NEEDLE'));
		const secret = await dispatchInstantGrep(host, request(repo, 'grep', 'SECRET_NEEDLE'));
		assert.strictEqual(hidden.source, 'index');
		assert.strictEqual(secret.source, 'index');
		assert.ok(!hidden.text.includes('HIDDEN_NEEDLE'));
		assert.ok(!secret.text.includes('SECRET_NEEDLE'));

		writeFileSync(join(repo, '.nexusignore'), '!secret.txt\n');
		host.applyPending(repo, 'secret.txt');
		host.resetIndexToHead(repo);
		const restored = await dispatchInstantGrep(host, request(repo, 'grep', 'SECRET_NEEDLE'));
		assert.strictEqual(restored.source, 'index');
		assert.ok(restored.text.includes('secret.txt'));
		assert.ok(restored.text.includes('SECRET_NEEDLE'));

		const scanned = await dispatchInstantGrep(host, request(repo, 'grep', 'SECRET_NEEDLE', { enabled: false }));
		const scannedHidden = await dispatchInstantGrep(host, request(repo, 'grep', 'HIDDEN_NEEDLE', { enabled: false }));
		assert.strictEqual(scanned.source, 'scan');
		assert.ok(scanned.text.includes('SECRET_NEEDLE'));
		assert.strictEqual(scannedHidden.source, 'scan');
		assert.ok(!scannedHidden.text.includes('HIDDEN_NEEDLE'));
		host.dispose();
	});

	test('a missing cache rebuilds on the next open', () => {
		const repo = createRepo('rebuild');
		writeFileSync(join(repo, 'src', 'pay.ts'), 'export const rebuilt = 1;\n');
		commit(repo, 'rebuild');
		const host = new InstantGrepHost({ watch: false });
		host.open(repo);
		const sha = git(repo, ['rev-parse', 'HEAD']);
		const metaPath = join(repo, '.git', 'nexus', 'crepe', sha, 'metadata.json');
		assert.ok(existsSync(metaPath));
		rmSync(join(repo, '.git', 'nexus'), { recursive: true, force: true });
		host.open(repo);
		const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { version: number; git_revision: string };
		assert.strictEqual(meta.version, 4);
		assert.strictEqual(meta.git_revision, sha);
		host.dispose();
	});

	test('an indexer crash leaves the host up and the tool call succeeds via the direct scan', async () => {
		const repo = createRepo('crash');
		writeFileSync(join(repo, 'src', 'pay.ts'), 'export class PaymentService {}\n');
		commit(repo, 'crash');
		const host = new InstantGrepHost({ watch: false, failBuild: true });
		const first = await dispatchInstantGrep(host, request(repo, 'grep', 'PaymentService'));
		const second = await dispatchInstantGrep(host, request(repo, 'grep', 'PaymentService'));
		assert.strictEqual(first.source, 'scan');
		assert.strictEqual(second.source, 'scan');
		assert.ok(first.text.includes('PaymentService'));
		assert.ok(second.text.includes('PaymentService'));
		assert.ok(!existsSync(join(repo, '.git', 'nexus')));
		host.dispose();
	});

	test('a one-file edit does not rewrite the loaded commit directory', async () => {
		const repo = createRepo('edit');
		writeFileSync(join(repo, 'src', 'pay.ts'), 'export const before = 1;\n');
		commit(repo, 'edit');
		const host = new InstantGrepHost({ watch: false });
		host.open(repo);
		host.resetIndexToHead(repo);
		const before = fingerprint(repo);
		const generation = host.generation(repo);
		writeFileSync(join(repo, 'src', 'pay.ts'), 'export const UNIQUE_TOKEN = 1;\n');
		host.applyPending(repo, 'src/pay.ts');
		const held = await dispatchInstantGrep(host, request(repo, 'grep', 'UNIQUE_TOKEN'));
		assert.strictEqual(held.source, 'index');
		assert.ok(!held.text.includes('UNIQUE_TOKEN'));
		assert.strictEqual(fingerprint(repo), before);
		assert.strictEqual(host.generation(repo), generation);
		host.resetIndexToHead(repo);
		const next = await dispatchInstantGrep(host, request(repo, 'grep', 'UNIQUE_TOKEN'));
		assert.strictEqual(next.source, 'index');
		assert.ok(next.text.includes('UNIQUE_TOKEN'));
		assert.strictEqual(fingerprint(repo), before);
		assert.ok(host.generation(repo) > generation);
		host.dispose();
	});

	test('a file that never entered the index is absent for Grep and Glob', async () => {
		const repo = createRepo('absent');
		writeFileSync(join(repo, 'src', 'pay.ts'), 'export const listed = 1;\n');
		commit(repo, 'absent');
		const host = new InstantGrepHost({ watch: false });
		host.open(repo);
		host.resetIndexToHead(repo);
		writeFileSync(join(repo, 'ghost.ts'), 'export const GHOST_NEEDLE = 1;\n');
		const grep = await dispatchInstantGrep(host, request(repo, 'grep', 'GHOST_NEEDLE'));
		const glob = await dispatchInstantGrep(host, request(repo, 'glob', '**/*.ts'));
		assert.strictEqual(grep.source, 'index');
		assert.strictEqual(glob.source, 'index');
		assert.ok(!grep.text.includes('GHOST_NEEDLE'));
		assert.ok(!grep.text.includes('ghost.ts'));
		assert.ok(glob.text.includes('src/pay.ts'));
		assert.ok(!glob.text.includes('ghost.ts'));
		host.dispose();
	});

	test('a nested repo that is not a submodule is found by the direct scan', async () => {
		const repo = createRepo('nested-parent');
		writeFileSync(join(repo, 'src', 'pay.ts'), 'export const parent = 1;\n');
		commit(repo, 'parent');
		const nested = join(repo, 'nested');
		mkdirSync(nested);
		git(nested, ['init', '-b', 'main']);
		writeFileSync(join(nested, 'hidden.ts'), 'export const NESTED_NEEDLE = 1;\n');
		commit(nested, 'nested');
		const host = new InstantGrepHost({ watch: false });
		const fromParent = await dispatchInstantGrep(host, request(repo, 'grep', 'NESTED_NEEDLE'));
		const globParent = await dispatchInstantGrep(host, request(repo, 'glob', '**/*.ts'));
		assert.strictEqual(fromParent.source, 'index');
		assert.strictEqual(globParent.source, 'index');
		assert.ok(!fromParent.text.includes('NESTED_NEEDLE'));
		assert.ok(!globParent.text.includes('hidden.ts'));
		const scanned = await dispatchInstantGrep(host, request(repo, 'grep', 'NESTED_NEEDLE', { paths: [nested] }));
		const scannedGlob = await dispatchInstantGrep(host, request(repo, 'glob', '**/*.ts', { paths: [nested] }));
		assert.strictEqual(scanned.source, 'scan');
		assert.strictEqual(scannedGlob.source, 'scan');
		assert.ok(scanned.text.includes('NESTED_NEEDLE'));
		assert.ok(scanned.text.includes('hidden.ts'));
		assert.ok(scannedGlob.text.includes('hidden.ts'));
		host.dispose();
	});

	test('a hash collision may add candidates and must not drop a true hit', async () => {
		const repo = createRepo('collision');
		writeFileSync(join(repo, 'src', 'pay.ts'), 'export class PaymentService {}\n');
		writeFileSync(join(repo, 'src', 'other.ts'), 'export const untouched = 1;\n');
		commit(repo, 'collision');
		const host = new InstantGrepHost({ watch: false, hash: () => 1n });
		const result = await dispatchInstantGrep(host, request(repo, 'grep', 'PaymentService'));
		assert.strictEqual(result.source, 'index');
		assert.ok(result.text.includes('src/pay.ts'));
		assert.ok(!result.text.includes('other.ts'));
		host.dispose();
	});

	test('a submodule is searched through the parent index', async () => {
		const child = createRepo('sub-child');
		writeFileSync(join(child, 'src', 'mod.ts'), 'export const SUB_NEEDLE = 1;\n');
		commit(child, 'child');
		const repo = createRepo('sub-parent');
		writeFileSync(join(repo, 'src', 'pay.ts'), 'export const parent = 1;\n');
		commit(repo, 'parent');
		git(repo, ['submodule', 'add', child, 'vendor/mod']);
		commit(repo, 'add submodule');
		const host = new InstantGrepHost({ watch: false });
		const result = await dispatchInstantGrep(host, request(repo, 'grep', 'SUB_NEEDLE'));
		assert.strictEqual(result.source, 'index');
		assert.ok(result.text.includes('vendor/mod/src/mod.ts'), result.text);
		assert.ok(result.text.includes('SUB_NEEDLE'));
		host.dispose();
	});

	test('linked worktrees share the common git dir cache', () => {
		const repo = createRepo('worktree');
		writeFileSync(join(repo, 'src', 'pay.ts'), 'export const shared = 1;\n');
		commit(repo, 'worktree');
		const linked = join(root, 'linked-worktree');
		git(repo, ['worktree', 'add', '--detach', linked]);
		assert.strictEqual(cacheDirectory(repo), cacheDirectory(linked));
	});

	test('Restricted Mode writes nothing under the git dir', async () => {
		const repo = createRepo('restricted');
		writeFileSync(join(repo, 'src', 'pay.ts'), 'export class PaymentService {}\n');
		commit(repo, 'restricted');
		const host = new InstantGrepHost({ watch: false });
		host.open(repo, { restricted: true });
		const result = await dispatchInstantGrep(host, request(repo, 'grep', 'PaymentService', { restricted: true }));
		assert.strictEqual(result.source, 'scan');
		assert.ok(result.text.includes('PaymentService'));
		assert.ok(!existsSync(join(repo, '.git', 'nexus')));
		host.dispose();
	});

	function createRepo(name: string): string {
		const repo = join(root, name);
		mkdirSync(join(repo, 'src'), { recursive: true });
		git(repo, ['init', '-b', 'main']);
		return repo;
	}

	function request(repo: string, kind: 'grep' | 'glob', pattern: string, extra?: { enabled?: boolean; restricted?: boolean; paths?: string[] }): IInstantGrepRequest {
		return {
			kind,
			roots: [repo],
			pattern,
			paths: extra?.paths,
			enabled: extra?.enabled !== false,
			restricted: extra?.restricted === true,
		};
	}

	function fingerprint(repo: string): string {
		const sha = git(repo, ['rev-parse', 'HEAD']);
		const dir = join(repo, '.git', 'nexus', 'crepe', sha);
		return ['index.bin', 'postings.bin', 'metadata.json'].map(name => createHash('sha256').update(readFileSync(join(dir, name))).digest('hex')).join(':');
	}
});

function commit(repo: string, message: string): void {
	git(repo, ['add', '-A']);
	git(repo, ['commit', '-m', message]);
}

function git(repo: string, args: string[]): string {
	return execFileSync('git', ['-c', 'safe.directory=*', '-c', 'protocol.file.allow=always', '-c', 'user.email=dev@example.com', '-c', 'user.name=Nexus', ...args], {
		cwd: repo,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	}).trim();
}
