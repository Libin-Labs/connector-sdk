export interface ConnectorCheckpoint {
  readonly version: 1;
  readonly cursor: string | null;
  readonly pagesCompleted: number;
  readonly done: boolean;
}

export interface ConnectorPage<T> {
  readonly records: readonly T[];
  readonly nextCursor: string | null;
}

export interface ConnectorPageContext {
  readonly cursor: string | null;
  readonly signal?: AbortSignal;
  readonly pageNumber: number;
}

export interface ConnectorAdapter<T> {
  readonly id: string;
  readonly capabilities?: readonly string[];
  open?(context: { readonly signal?: AbortSignal }): void | Promise<void>;
  fetchPage(context: ConnectorPageContext): ConnectorPage<T> | Promise<ConnectorPage<T>>;
  close(): void | Promise<void>;
}

export interface ConnectorCheckpointStore {
  load(): ConnectorCheckpoint | undefined | Promise<ConnectorCheckpoint | undefined>;
  save(checkpoint: ConnectorCheckpoint): void | Promise<void>;
}

export interface ConnectorRunOptions<T> {
  readonly signal?: AbortSignal;
  readonly maxPages?: number;
  readonly beforePage?: (pageNumber: number, signal?: AbortSignal) => void | Promise<void>;
  readonly onRecords: (records: readonly T[], pageNumber: number) => void | Promise<void>;
}

export interface ConnectorRunResult {
  readonly pagesCompleted: number;
  readonly recordsDelivered: number;
  readonly checkpoint: ConnectorCheckpoint;
}

export class ConnectorError extends Error {
  constructor(
    readonly code:
      | 'invalid-adapter'
      | 'invalid-page'
      | 'invalid-checkpoint'
      | 'aborted'
      | 'page-limit'
      | 'cursor-cycle'
      | 'open-failed'
      | 'fetch-failed'
      | 'consume-failed'
      | 'checkpoint-failed'
      | 'cleanup-failed',
    message: string,
    readonly causeValue?: unknown,
    readonly cleanupCause?: unknown,
  ) {
    super(message);
    this.name = 'ConnectorError';
  }
}

export function declareConnectorCapabilities(capabilities: readonly string[]): readonly string[] {
  if (!Array.isArray(capabilities)) throw new TypeError('Capabilities must be an array.');
  const result = new Set<string>();
  for (const capability of capabilities) {
    if (typeof capability !== 'string' || capability.length < 1 || capability.length > 128) {
      throw new TypeError('Capabilities must be non-empty strings up to 128 characters.');
    }
    if (result.has(capability))
      throw new TypeError(`Duplicate connector capability "${capability}".`);
    result.add(capability);
  }
  return Object.freeze([...result]);
}

function validateCheckpoint(input: unknown): ConnectorCheckpoint {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype
  ) {
    throw new ConnectorError('invalid-checkpoint', 'Checkpoint must be a plain object.');
  }
  const value = input as Record<string, unknown>;
  if (
    Reflect.ownKeys(value).some(
      (key) =>
        typeof key !== 'string' || !['version', 'cursor', 'pagesCompleted', 'done'].includes(key),
    ) ||
    Reflect.ownKeys(value).some((key) => {
      const descriptor =
        typeof key === 'string' ? Object.getOwnPropertyDescriptor(value, key) : null;
      return !descriptor || !descriptor.enumerable || !('value' in descriptor);
    }) ||
    ['version', 'cursor', 'pagesCompleted', 'done'].some((key) => !Object.hasOwn(value, key)) ||
    value.version !== 1 ||
    (value.cursor !== null && (typeof value.cursor !== 'string' || value.cursor.length > 4_096)) ||
    !Number.isSafeInteger(value.pagesCompleted) ||
    (value.pagesCompleted as number) < 0 ||
    typeof value.done !== 'boolean'
  ) {
    throw new ConnectorError('invalid-checkpoint', 'Checkpoint fields are malformed.');
  }
  return {
    version: 1,
    cursor: value.cursor as string | null,
    pagesCompleted: value.pagesCompleted as number,
    done: value.done,
  };
}

function abortIfRequested(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ConnectorError('aborted', 'Connector run was cancelled.');
}

export async function runConnector<T>(
  adapter: ConnectorAdapter<T>,
  checkpoints: ConnectorCheckpointStore,
  options: ConnectorRunOptions<T>,
): Promise<ConnectorRunResult> {
  if (
    !adapter ||
    typeof adapter.id !== 'string' ||
    adapter.id.length < 1 ||
    adapter.id.length > 128 ||
    typeof adapter.fetchPage !== 'function' ||
    typeof adapter.close !== 'function' ||
    (adapter.open !== undefined && typeof adapter.open !== 'function') ||
    !checkpoints ||
    typeof checkpoints.load !== 'function' ||
    typeof checkpoints.save !== 'function' ||
    !options ||
    typeof options.onRecords !== 'function'
  ) {
    throw new ConnectorError(
      'invalid-adapter',
      'A connector id, page adapter, checkpoint store, and record handler are required.',
    );
  }
  const maxPages = options.maxPages ?? 10_000;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) {
    throw new RangeError('maxPages must be a positive safe integer.');
  }
  let checkpoint: ConnectorCheckpoint;
  try {
    const saved = await checkpoints.load();
    checkpoint =
      saved === undefined
        ? { version: 1, cursor: null, pagesCompleted: 0, done: false }
        : validateCheckpoint(saved);
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    throw new ConnectorError('checkpoint-failed', 'Could not load connector checkpoint.', error);
  }
  if (checkpoint.done) {
    return { pagesCompleted: 0, recordsDelivered: 0, checkpoint };
  }

  let opened = false;
  let primaryError: unknown;
  let recordsDelivered = 0;
  let pagesThisRun = 0;
  const visited = new Set<string>();
  if (checkpoint.cursor !== null) visited.add(checkpoint.cursor);
  try {
    abortIfRequested(options.signal);
    try {
      await adapter.open?.({
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      opened = true;
    } catch (error) {
      throw new ConnectorError('open-failed', 'Connector open failed.', error);
    }
    while (!checkpoint.done) {
      abortIfRequested(options.signal);
      if (pagesThisRun >= maxPages) {
        throw new ConnectorError('page-limit', 'Connector page limit exceeded before completion.');
      }
      const pageNumber = checkpoint.pagesCompleted + 1;
      try {
        await options.beforePage?.(pageNumber, options.signal);
      } catch (error) {
        if (error instanceof ConnectorError) throw error;
        throw new ConnectorError('fetch-failed', 'Connector before-page hook failed.', error);
      }
      abortIfRequested(options.signal);
      let page: ConnectorPage<T>;
      try {
        page = await adapter.fetchPage({
          cursor: checkpoint.cursor,
          pageNumber,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
      } catch (error) {
        if (error instanceof ConnectorError) throw error;
        throw new ConnectorError('fetch-failed', 'Fetching a connector page failed.', error);
      }
      if (
        !page ||
        typeof page !== 'object' ||
        Array.isArray(page) ||
        Object.getPrototypeOf(page) !== Object.prototype ||
        Reflect.ownKeys(page).some(
          (key) =>
            typeof key !== 'string' ||
            !['records', 'nextCursor'].includes(key) ||
            !Object.getOwnPropertyDescriptor(page, key)?.enumerable ||
            !('value' in Object.getOwnPropertyDescriptor(page, key)!),
        ) ||
        !Object.hasOwn(page, 'records') ||
        !Object.hasOwn(page, 'nextCursor') ||
        !Array.isArray(page.records) ||
        (page.nextCursor !== null &&
          (typeof page.nextCursor !== 'string' || page.nextCursor.length > 4_096))
      ) {
        throw new ConnectorError('invalid-page', 'Connector returned a malformed page.');
      }
      abortIfRequested(options.signal);
      try {
        await options.onRecords(page.records, pageNumber);
      } catch (error) {
        if (error instanceof ConnectorError) throw error;
        throw new ConnectorError('consume-failed', 'Consuming connector records failed.', error);
      }
      abortIfRequested(options.signal);
      if (page.nextCursor !== null && visited.has(page.nextCursor)) {
        throw new ConnectorError('cursor-cycle', 'Connector cursor repeated; pagination stopped.');
      }
      if (page.nextCursor !== null) visited.add(page.nextCursor);
      const next: ConnectorCheckpoint = {
        version: 1,
        cursor: page.nextCursor,
        pagesCompleted: pageNumber,
        done: page.nextCursor === null,
      };
      try {
        await checkpoints.save(next);
      } catch (error) {
        throw new ConnectorError(
          'checkpoint-failed',
          'Could not save checkpoint after delivering a page.',
          error,
        );
      }
      recordsDelivered += page.records.length;
      pagesThisRun += 1;
      checkpoint = next;
    }
  } catch (error) {
    primaryError = error;
  }
  let cleanupError: unknown;
  if (opened) {
    try {
      await adapter.close();
    } catch (error) {
      cleanupError = error;
    }
  }
  if (primaryError !== undefined && cleanupError !== undefined) {
    throw new ConnectorError(
      'cleanup-failed',
      'Connector run failed and cleanup also failed.',
      primaryError,
      cleanupError,
    );
  }
  if (primaryError !== undefined) throw primaryError;
  if (cleanupError !== undefined) {
    throw new ConnectorError('cleanup-failed', 'Connector cleanup failed.', cleanupError);
  }
  return { pagesCompleted: pagesThisRun, recordsDelivered, checkpoint };
}
