# @lp-labs/connector-sdk

Define vendor-neutral paginated connector adapters with explicit lifecycle, checkpoints, cooperative
cancellation, and a record-consumption boundary. No vendor drivers or network behavior are included.

## Install and quick start

```sh
npm install @lp-labs/connector-sdk
```

```js
import { runConnector } from '@lp-labs/connector-sdk';

let checkpoint;
const store = {
  load: () => checkpoint,
  save: (next) => {
    checkpoint = next;
  },
};
const result = await runConnector(
  {
    id: 'catalog-demo',
    async fetchPage({ cursor }) {
      return cursor === null
        ? { records: [{ sku: 'A' }], nextCursor: null }
        : { records: [], nextCursor: null };
    },
    close() {},
  },
  store,
  {
    onRecords(records) {
      console.log(records);
    },
  },
);
if (result.checkpoint.done !== true) throw new Error('Connector did not finish');
```

## API and types

- `runConnector(adapter, checkpointStore, options)` loads progress, optionally opens the adapter,
  fetches and consumes pages, saves progress only after `onRecords` succeeds, and closes once.
- `ConnectorAdapter<T>` defines `id`, optional `capabilities`, optional `open`, required `fetchPage`,
  and required `close`.
- A page has a records array and opaque `nextCursor`; `null` means the source is complete.
- `ConnectorPage<T>` and `ConnectorPageContext` describe page results and the cursor, page number,
  and optional signal passed to the adapter.
- `ConnectorCheckpointStore` supplies async or sync `load` and `save` operations.
- `ConnectorRunOptions<T>` provides `onRecords`, optional cooperative `signal`, optional `maxPages`
  (default 10,000), and optional `beforePage`.
- `ConnectorRunResult.pagesCompleted` and `recordsDelivered` count this run; `checkpoint` contains
  total progress.
- `declareConnectorCapabilities(list)` validates and freezes unique descriptive capability names.
- `ConnectorError` exposes a stable `code`, primary `causeValue`, and optional `cleanupCause`.

## Checkpoint, failure, and lifecycle contracts

Page records must be durably accepted by `onRecords` before the next checkpoint is saved. If
consumption fails, the cursor does not advance. A checkpoint-save failure is reported after consumer
success; retry handling must account for possible duplicate consumption. Resume requires the caller's
store to preserve the opaque cursor and page count. Repeated cursors are rejected to prevent loops.
Cancellation is cooperative and checked around lifecycle, page, and consumer operations; adapters
and handlers should honor the passed `AbortSignal`.

`ConnectorError` codes are `invalid-adapter`, `invalid-page`, `invalid-checkpoint`, `aborted`,
`page-limit`, `cursor-cycle`, `open-failed`, `fetch-failed`, `consume-failed`,
`checkpoint-failed`, and `cleanup-failed`. `causeValue` retains the primary failure and
`cleanupCause` retains an additional cleanup failure. Close is attempted once after successful open
(or when no open hook exists); an open failure is not followed by close. A saved completed
checkpoint returns without opening the adapter.

This package does not provide rate-limit policy, credentials, persistence, retries, or exactly-once
delivery. Store and consumer atomicity are application responsibilities. There are no runtime or peer
dependencies; TypeScript and Prettier are development-only.

ESM, CommonJS, and TypeScript declarations are included.

## Support

If this library is useful to you, consider supporting its maintenance with a [donation via PayPal](https://www.paypal.me/LibinPrasanth).

## Author

Created by [Libin Prasanth](https://www.linkedin.com/in/libinprasanth/). Connect on LinkedIn for updates and discussion.
