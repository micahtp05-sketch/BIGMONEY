import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { WorkspaceStore } from '../src/business/store.ts';
import type { Business } from '../src/business/types.ts';

async function tempPath(name = 'workspace.json'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bigmoney-store-'));
  return join(dir, name);
}

function stubBusiness(id: string): Business {
  return {
    id,
    name: id,
    industry: '',
    model: 'other',
    stage: 'early',
    currency: 'USD',
    goals: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    snapshots: [],
    actions: [],
  };
}

describe('WorkspaceStore', () => {
  it('starts empty when the file does not exist yet', async () => {
    const store = await WorkspaceStore.open(await tempPath());
    assert.deepEqual(store.read(), { version: 1, businesses: [], ideas: [] });
  });

  it('persists a change and reads it back in a fresh process', async () => {
    const path = await tempPath();
    const store = await WorkspaceStore.open(path);
    await store.mutate((ws) => ws.businesses.push(stubBusiness('one')));

    const reopened = await WorkspaceStore.open(path);
    assert.equal(reopened.read().businesses.length, 1);
    assert.equal(reopened.read().businesses[0]?.name, 'one');
  });

  it('creates the containing directory rather than failing the first write', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'bigmoney-store-')), 'nested', 'deep', 'ws.json');
    const store = await WorkspaceStore.open(path);
    await store.mutate((ws) => ws.businesses.push(stubBusiness('one')));
    assert.ok(JSON.parse(await readFile(path, 'utf8')).businesses.length === 1);
  });

  it('serialises concurrent writes instead of interleaving them', async () => {
    const path = await tempPath();
    const store = await WorkspaceStore.open(path);
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        store.mutate((ws) => ws.businesses.push(stubBusiness(`b${i}`))),
      ),
    );
    const reopened = await WorkspaceStore.open(path);
    assert.equal(reopened.read().businesses.length, 25);
  });

  it('keeps writing after a mutation throws', async () => {
    const path = await tempPath();
    const store = await WorkspaceStore.open(path);
    await assert.rejects(
      store.mutate(() => {
        throw new Error('handler blew up');
      }),
      /handler blew up/,
    );
    await store.mutate((ws) => ws.businesses.push(stubBusiness('after')));
    assert.equal((await WorkspaceStore.open(path)).read().businesses.length, 1);
  });

  it('refuses to start on a corrupt file rather than overwriting it', async () => {
    const path = await tempPath();
    await writeFile(path, '{ not json', 'utf8');
    await assert.rejects(WorkspaceStore.open(path), /not valid JSON/);
    // The bad file is still there to be recovered by hand.
    assert.equal(await readFile(path, 'utf8'), '{ not json');
  });

  it('refuses a document written by a future version', async () => {
    const path = await tempPath();
    await writeFile(path, JSON.stringify({ version: 2, businesses: [], ideas: [] }), 'utf8');
    await assert.rejects(WorkspaceStore.open(path), /unsupported version/);
  });

  it('fills in collections a hand-edited file left out', async () => {
    const path = await tempPath();
    await writeFile(path, JSON.stringify({ version: 1, businesses: [stubBusiness('x')] }), 'utf8');
    const store = await WorkspaceStore.open(path);
    assert.deepEqual(store.read().ideas, []);
  });
});
