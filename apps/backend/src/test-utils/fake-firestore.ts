/**
 * An in-memory {@link FsDb} — tests only.
 *
 * Faithful to the two Firestore behaviours the safety argument leans on:
 *   - a transaction is serialised, and a document read inside it is re-read from
 *     the same store the writes land in, so read-then-create is atomic;
 *   - `set(..., { merge: true })` merges top-level fields, `set` without it
 *     replaces the document.
 *
 * It is NOT a Firestore emulator: query support is limited to the operators the
 * repos actually use, and it does not model contention retries (nothing here is
 * concurrent). See the VERIFY-LIVE note on `FsDb.runTransaction`.
 */

import type {
  FsCollectionRef,
  FsDb,
  FsDocRef,
  FsDocSnapshot,
  FsQuery,
  FsQuerySnapshot,
  FsTransaction,
  FsWhereOp,
} from '../adapters/firestore/db.js';

interface Filter {
  field: string;
  op: FsWhereOp;
  value: unknown;
}

function fieldValue(data: Record<string, unknown>, field: string): unknown {
  return field.split('.').reduce<unknown>((acc, part) => {
    if (typeof acc !== 'object' || acc === null) return undefined;
    return (acc as Record<string, unknown>)[part];
  }, data);
}

function matches(data: Record<string, unknown>, filter: Filter): boolean {
  const actual = fieldValue(data, filter.field);
  switch (filter.op) {
    case '==':
      return actual === filter.value;
    case '!=':
      return actual !== filter.value;
    case '<':
      return (actual as number) < (filter.value as number);
    case '<=':
      return (actual as number) <= (filter.value as number);
    case '>':
      return (actual as number) > (filter.value as number);
    case '>=':
      return (actual as number) >= (filter.value as number);
    case 'in':
      return Array.isArray(filter.value) && filter.value.includes(actual);
    case 'array-contains':
      return Array.isArray(actual) && actual.includes(filter.value);
    default:
      return false;
  }
}

class Snapshot implements FsDocSnapshot {
  constructor(
    readonly id: string,
    readonly exists: boolean,
    private readonly payload: Record<string, unknown> | undefined,
  ) {}

  data(): Record<string, unknown> | undefined {
    return this.payload === undefined ? undefined : structuredClone(this.payload);
  }
}

export class FakeFirestore implements FsDb {
  /** Full document path → document data. */
  readonly docs = new Map<string, Record<string, unknown>>();
  /** Every write, in order — lets a test assert on merge semantics. */
  readonly writes: { path: string; merge: boolean }[] = [];
  readonly deletes: string[] = [];
  transactions = 0;

  seed(path: string, data: Record<string, unknown>): void {
    this.docs.set(path, structuredClone(data));
  }

  doc(path: string): FsDocRef {
    return this.#ref(path);
  }

  collection(path: string): FsCollectionRef {
    return Object.assign(this.#query(path, []), {
      doc: (id: string): FsDocRef => this.#ref(`${path}/${id}`),
    });
  }

  async runTransaction<T>(fn: (txn: FsTransaction) => Promise<T>): Promise<T> {
    this.transactions += 1;
    const txn: FsTransaction = {
      get: (ref) => this.#ref((ref as InternalRef).path).get(),
      set: (ref, data, options) => {
        this.#write((ref as InternalRef).path, data, options?.merge === true);
      },
    };
    return fn(txn);
  }

  #write(path: string, data: Record<string, unknown>, merge: boolean): void {
    const existing = this.docs.get(path);
    this.docs.set(
      path,
      merge && existing !== undefined
        ? { ...existing, ...structuredClone(data) }
        : structuredClone(data),
    );
    this.writes.push({ path, merge });
  }

  #ref(path: string): FsDocRef {
    const id = path.slice(path.lastIndexOf('/') + 1);
    const ref: InternalRef = {
      path,
      id,
      get: () => {
        const data = this.docs.get(path);
        return Promise.resolve(new Snapshot(id, data !== undefined, data));
      },
      set: (data, options) => {
        this.#write(path, data, options?.merge === true);
        return Promise.resolve(undefined);
      },
      delete: () => {
        this.docs.delete(path);
        this.deletes.push(path);
        return Promise.resolve(undefined);
      },
    };
    return ref;
  }

  #query(collectionPath: string, filters: Filter[]): FsQuery {
    return {
      where: (field, op, value): FsQuery =>
        this.#query(collectionPath, [...filters, { field, op, value }]),
      orderBy: (): FsQuery => this.#query(collectionPath, filters),
      limit: (): FsQuery => this.#query(collectionPath, filters),
      get: (): Promise<FsQuerySnapshot> => {
        const prefix = `${collectionPath}/`;
        const docs: FsDocSnapshot[] = [];
        for (const [path, data] of this.docs) {
          if (!path.startsWith(prefix)) continue;
          // Only direct children — a sub-collection is not part of this query.
          if (path.slice(prefix.length).includes('/')) continue;
          if (!filters.every((f) => matches(data, f))) continue;
          docs.push(new Snapshot(path.slice(prefix.length), true, data));
        }
        return Promise.resolve({ docs });
      },
    };
  }
}

interface InternalRef extends FsDocRef {
  readonly path: string;
}
