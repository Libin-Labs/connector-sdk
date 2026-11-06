import {
  runConnector,
  type ConnectorAdapter,
  type ConnectorCheckpoint,
} from '@lp-labs/connector-sdk';

const adapter: ConnectorAdapter<{ id: string }> = {
  id: 'typed-source',
  fetchPage: () => ({ records: [{ id: '1' }], nextCursor: null }),
  close() {},
};
let saved: ConnectorCheckpoint | undefined;
void runConnector(
  adapter,
  {
    load: () => saved,
    save: (next) => {
      saved = next;
    },
  },
  {
    onRecords(records) {
      records[0]?.id.toUpperCase();
    },
  },
);
