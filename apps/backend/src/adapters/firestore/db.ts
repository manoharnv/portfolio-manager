/**
 * The narrow slice of Firestore this backend actually uses.
 *
 * Declaring it ourselves (rather than importing `firebase-admin`'s `Firestore`
 * into every repo) buys two things: the repos are unit-testable against an
 * in-memory fake with no emulator and no network, and the surface we depend on
 * is small enough to audit. The composition root adapts the real Admin SDK
 * `Firestore` onto this interface.
 */

export interface FsDocSnapshot {
  readonly id: string;
  readonly exists: boolean;
  data(): Record<string, unknown> | undefined;
}

export interface FsQuerySnapshot {
  readonly docs: readonly FsDocSnapshot[];
}

export type FsWhereOp = '==' | '!=' | '<' | '<=' | '>' | '>=' | 'in' | 'array-contains';

export interface FsQuery {
  where(field: string, op: FsWhereOp, value: unknown): FsQuery;
  orderBy(field: string, direction?: 'asc' | 'desc'): FsQuery;
  limit(n: number): FsQuery;
  get(): Promise<FsQuerySnapshot>;
}

export interface FsDocRef {
  readonly id: string;
  get(): Promise<FsDocSnapshot>;
  set(data: Record<string, unknown>, options?: { merge?: boolean }): Promise<unknown>;
  delete(): Promise<unknown>;
}

export interface FsCollectionRef extends FsQuery {
  doc(id: string): FsDocRef;
}

export interface FsTransaction {
  get(ref: FsDocRef): Promise<FsDocSnapshot>;
  set(ref: FsDocRef, data: Record<string, unknown>, options?: { merge?: boolean }): void;
}

export interface FsDb {
  collection(path: string): FsCollectionRef;
  doc(path: string): FsDocRef;
  /**
   * VERIFY-LIVE: the exactly-once guarantee rests on Firestore's documented
   * behaviour that a transaction which *reads* a document and then writes it
   * re-runs when that document changed underneath it. Both the idempotency
   * `acquire` and the proposal compare-and-set rely on it.
   */
  runTransaction<T>(fn: (txn: FsTransaction) => Promise<T>): Promise<T>;
}

/** Firestore rejects `undefined` values; drop those keys instead. */
export function stripUndefined(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}
