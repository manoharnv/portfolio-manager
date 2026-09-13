/**
 * In-memory fakes for the ports in `../ports.js`. Excluded from the build and
 * from coverage (vitest.config.ts, tsconfig.build.json) — nothing in `dist/`
 * imports this file. docs/00 §0.5: this is what makes handler tests run with
 * no network, no real Firestore, no real FCM.
 */
import type {
  Clock,
  Db,
  DbBatch,
  Messaging,
  MulticastPayload,
  MulticastResult,
  QueryFilter,
  QueryResultDoc,
  SendFailure,
} from '../ports.js';

/** Deep-clones plain JSON-shaped fixture data so callers can't mutate the store by reference. */
function clone<T>(data: T): T {
  return JSON.parse(JSON.stringify(data)) as T;
}

function compareValues(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') {
    return a - b;
  }
  const as = String(a);
  const bs = String(b);
  if (as < bs) return -1;
  if (as > bs) return 1;
  return 0;
}

/**
 * NB: this is a test double, not a Firestore emulator. Equality/ordering is
 * approximated with plain JS comparison, which is exact for the shapes this
 * package's fixtures use (fixed-width ISO-8601 UTC strings, plain numbers).
 * The real query semantics live in `adapters/admin.ts`, backed by the actual
 * Firestore query builder.
 */
function matchesFilter(data: Record<string, unknown>, filter: QueryFilter): boolean {
  const actual = data[filter.field];
  switch (filter.op) {
    case '==':
      return actual === filter.value;
    case '!=':
      return actual !== filter.value;
    case '<':
      return compareValues(actual, filter.value) < 0;
    case '<=':
      return compareValues(actual, filter.value) <= 0;
    case '>':
      return compareValues(actual, filter.value) > 0;
    case '>=':
      return compareValues(actual, filter.value) >= 0;
  }
}

let autoIdSeq = 0;

export class FakeDb implements Db {
  private readonly store = new Map<string, Record<string, unknown>>();
  /** Every `queryCollection` call this instance has served — for pagination assertions. */
  queryCalls = 0;

  /** Test setup: seed a document at a full doc path, e.g. `proposals/p1`. */
  seed(path: string, data: Record<string, unknown>): void {
    this.store.set(path, clone(data));
  }

  /** Test assertion: read the current state of a document, or `undefined`. */
  get(path: string): Record<string, unknown> | undefined {
    const doc = this.store.get(path);
    return doc === undefined ? undefined : clone(doc);
  }

  /** Test assertion: every `path -> data` pair currently in the store. */
  entries(): Array<[string, Record<string, unknown>]> {
    return [...this.store.entries()].map(([path, data]) => [path, clone(data)]);
  }

  async getDoc<T>(path: string): Promise<T | undefined> {
    const doc = this.store.get(path);
    return doc === undefined ? undefined : (clone(doc) as T);
  }

  async setDoc(path: string, data: Record<string, unknown>): Promise<void> {
    this.store.set(path, clone(data));
  }

  async updateDoc(path: string, data: Record<string, unknown>): Promise<void> {
    const existing = this.store.get(path) ?? {};
    this.store.set(path, { ...existing, ...clone(data) });
  }

  async queryCollection<T>(
    path: string,
    filters: QueryFilter[],
    limit?: number,
  ): Promise<Array<QueryResultDoc<T>>> {
    this.queryCalls += 1;
    const prefix = `${path}/`;
    const results: Array<QueryResultDoc<T>> = [];
    for (const [docPath, data] of this.store) {
      if (!docPath.startsWith(prefix)) continue;
      const rest = docPath.slice(prefix.length);
      if (rest.includes('/')) continue; // a direct child only — a collection, not a subtree
      if (!filters.every((filter) => matchesFilter(data, filter))) continue;
      results.push({ id: rest, path: docPath, data: clone(data) as T });
      if (limit !== undefined && results.length >= limit) break;
    }
    return results;
  }

  async addDoc(collectionPath: string, data: Record<string, unknown>): Promise<string> {
    autoIdSeq += 1;
    const id = `auto${autoIdSeq}`;
    this.store.set(`${collectionPath}/${id}`, clone(data));
    return id;
  }

  batch(): DbBatch {
    const pending: Array<{ kind: 'set' | 'update'; path: string; data: Record<string, unknown> }> =
      [];
    return {
      set: (path, data) => {
        pending.push({ kind: 'set', path, data });
      },
      update: (path, data) => {
        pending.push({ kind: 'update', path, data });
      },
      commit: async () => {
        for (const op of pending) {
          if (op.kind === 'set') {
            this.store.set(op.path, clone(op.data));
          } else {
            const existing = this.store.get(op.path) ?? {};
            this.store.set(op.path, { ...existing, ...clone(op.data) });
          }
        }
      },
    };
  }
}

export interface RecordedSend {
  tokens: string[];
  notification: { title: string; body: string };
  data: Record<string, string>;
}

export class FakeMessaging implements Messaging {
  readonly sent: RecordedSend[] = [];
  /** token → FCM error code to report as a failure for that token. */
  readonly failTokens = new Map<string, string>();
  /** When set, `sendEachForMulticast` rejects with this instead of returning. */
  throwOnSend: Error | undefined;

  async sendEachForMulticast(payload: MulticastPayload): Promise<MulticastResult> {
    if (this.throwOnSend) {
      throw this.throwOnSend;
    }
    this.sent.push({
      tokens: payload.tokens,
      notification: payload.notification,
      data: payload.data,
    });
    const failures: SendFailure[] = [];
    for (const token of payload.tokens) {
      const code = this.failTokens.get(token);
      if (code !== undefined) {
        failures.push({ token, code });
      }
    }
    return { failures };
  }
}

export class FakeClock implements Clock {
  constructor(private current: Date) {}

  now(): Date {
    return this.current;
  }

  set(date: Date): void {
    this.current = date;
  }
}
