import { runConnector, type ConnectorCheckpointStore } from '@lp-labs/connector-sdk';

const store: ConnectorCheckpointStore = { load: () => undefined, save: () => {} };
void runConnector(
  {
    id: 'source',
    fetchPage: () => ({ records: [1], nextCursor: null }),
    close() {},
  },
  store,
  {
    onRecords(records) {
      records.forEach((value) => value.toFixed());
    },
  },
);
