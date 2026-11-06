import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ConnectorError, declareConnectorCapabilities, runConnector } from '../dist/esm/index.js';

function memoryStore(initial) {
  return {
    value: initial,
    saves: [],
    load() {
      return this.value;
    },
    save(checkpoint) {
      this.value = checkpoint;
      this.saves.push(checkpoint);
    },
  };
}

test('persists each consumed page and resumes from the saved cursor', async () => {
  const store = memoryStore(undefined);
  const delivered = [];
  let closed = 0;
  const adapter = {
    id: 'test',
    async fetchPage({ cursor }) {
      if (cursor === null) return { records: ['a'], nextCursor: 'next' };
      throw new Error('simulated outage');
    },
    close() {
      closed += 1;
    },
  };
  await assert.rejects(
    runConnector(adapter, store, { onRecords: (records) => delivered.push(...records) }),
    (error) => error.code === 'fetch-failed',
  );
  assert.deepEqual(delivered, ['a']);
  assert.deepEqual(store.value, { version: 1, cursor: 'next', pagesCompleted: 1, done: false });
  assert.equal(closed, 1);
  const resumed = await runConnector(
    {
      id: 'test',
      fetchPage({ cursor }) {
        assert.equal(cursor, 'next');
        return { records: ['b'], nextCursor: null };
      },
      close() {
        closed += 1;
      },
    },
    store,
    { onRecords: (records) => delivered.push(...records) },
  );
  assert.deepEqual(delivered, ['a', 'b']);
  assert.equal(resumed.recordsDelivered, 1);
  assert.equal(resumed.checkpoint.done, true);
  assert.equal(closed, 2);
});

test('does not checkpoint an unconsumed page and always closes after consumer failure', async () => {
  const store = memoryStore(undefined);
  let closed = 0;
  await assert.rejects(
    runConnector(
      {
        id: 'consumer-fails',
        fetchPage: () => ({ records: [1], nextCursor: 'later' }),
        close() {
          closed += 1;
        },
      },
      store,
      {
        onRecords: () => {
          throw new Error('consumer failed');
        },
      },
    ),
    (error) => error.code === 'consume-failed',
  );
  assert.equal(store.value, undefined);
  assert.equal(closed, 1);
});

test('detects malformed pages and repeated cursors; closes on either failure', async () => {
  const store = memoryStore(undefined);
  let closed = 0;
  await assert.rejects(
    runConnector(
      {
        id: 'cycle',
        fetchPage: ({ cursor }) => ({ records: [], nextCursor: cursor ?? 'same' }),
        close() {
          closed += 1;
        },
      },
      store,
      { onRecords() {} },
    ),
    (error) => error.code === 'cursor-cycle',
  );
  await assert.rejects(
    runConnector(
      {
        id: 'bad-page',
        fetchPage: () => ({ records: null, nextCursor: null }),
        close() {
          closed += 1;
        },
      },
      memoryStore(undefined),
      { onRecords() {} },
    ),
    (error) => error.code === 'invalid-page',
  );
  assert.equal(closed, 2);
});

test('cancellation is cooperative and cleanup failure retains the original error', async () => {
  const controller = new AbortController();
  let closed = 0;
  await assert.rejects(
    runConnector(
      {
        id: 'cancel',
        fetchPage() {
          throw new Error('must not fetch');
        },
        close() {
          closed += 1;
        },
      },
      memoryStore(undefined),
      {
        signal: controller.signal,
        async beforePage() {
          controller.abort();
        },
        onRecords() {},
      },
    ),
    (error) => error.code === 'aborted',
  );
  assert.equal(closed, 1);
  await assert.rejects(
    runConnector(
      {
        id: 'cleanup',
        fetchPage() {
          throw new Error('fetch broke');
        },
        close() {
          throw new Error('close broke');
        },
      },
      memoryStore(undefined),
      { onRecords() {} },
    ),
    (error) =>
      error.code === 'cleanup-failed' &&
      error.causeValue.code === 'fetch-failed' &&
      error.cleanupCause.message === 'close broke',
  );
});

test('validates checkpoints, page bounds, capabilities, and completed runs', async () => {
  const doneStore = memoryStore({ version: 1, cursor: null, pagesCompleted: 0, done: true });
  let opened = 0;
  const completed = await runConnector(
    {
      id: 'done',
      open() {
        opened += 1;
      },
      fetchPage() {
        throw new Error('must not run');
      },
      close() {},
    },
    doneStore,
    { onRecords() {} },
  );
  assert.equal(completed.checkpoint.done, true);
  assert.equal(opened, 0);
  assert.throws(() => declareConnectorCapabilities(['page', 'page']), /Duplicate/);
  assert.deepEqual(declareConnectorCapabilities(['page', 'resume']), ['page', 'resume']);
  await assert.rejects(
    runConnector(
      {
        id: 'invalid',
        fetchPage: () => ({ records: [], nextCursor: null }),
        close() {},
      },
      memoryStore({ version: 2 }),
      { onRecords() {} },
    ),
    (error) => error instanceof ConnectorError && error.code === 'invalid-checkpoint',
  );
});

test('CommonJS exposes the same runtime API', () => {
  const cjs = createRequire(import.meta.url)('../dist/cjs/index.js');
  assert.deepEqual(Object.keys(cjs).sort(), [
    'ConnectorError',
    'declareConnectorCapabilities',
    'runConnector',
  ]);
});
