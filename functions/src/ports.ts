/**
 * Minimal interfaces so every handler in `handlers/` is a pure function that
 * can be unit-tested without the Firebase Admin SDK or the Cloud Functions
 * runtime (docs/00-dev-conventions.md §0.5: "No network in unit tests. Ever.").
 *
 * `adapters/admin.ts` is the only file that implements these against the real
 * SDKs; `test-utils/fakes.ts` is the only file that fakes them. Handlers,
 * `notify.ts` and `catalogue.ts` never import `firebase-admin` or
 * `firebase-functions` (except the `logger`, which is a structured-log
 * function, not a network call).
 */

// ---------------------------------------------------------------------------
// Db — a narrow slice of Firestore, addressed by plain slash-delimited paths
// (e.g. `users/${uid}`, `brokerSessions/${uid}/brokers/${broker}`).
// ---------------------------------------------------------------------------

export type FilterOp = '==' | '!=' | '<' | '<=' | '>' | '>=';

export interface QueryFilter {
  field: string;
  op: FilterOp;
  value: unknown;
}

export interface QueryResultDoc<T> {
  id: string;
  path: string;
  data: T;
}

export interface DbBatch {
  set(path: string, data: Record<string, unknown>): void;
  update(path: string, data: Record<string, unknown>): void;
  commit(): Promise<void>;
}

export interface Db {
  getDoc<T>(path: string): Promise<T | undefined>;
  setDoc(path: string, data: Record<string, unknown>): Promise<void>;
  updateDoc(path: string, data: Record<string, unknown>): Promise<void>;
  queryCollection<T>(
    path: string,
    filters: QueryFilter[],
    limit?: number,
  ): Promise<Array<QueryResultDoc<T>>>;
  batch(): DbBatch;
  /** Auto-generates the document id (Firestore `.add()` semantics) and returns it. */
  addDoc(collectionPath: string, data: Record<string, unknown>): Promise<string>;
}

// ---------------------------------------------------------------------------
// Messaging — narrowed to the one FCM call the notification handlers need.
// ---------------------------------------------------------------------------

export interface PushNotificationContent {
  title: string;
  body: string;
}

export interface MulticastPayload {
  tokens: string[];
  notification: PushNotificationContent;
  data: Record<string, string>;
}

export interface SendFailure {
  token: string;
  /** e.g. `messaging/registration-token-not-registered` — see functions/README.md VERIFY-LIVE. */
  code: string;
}

export interface MulticastResult {
  failures: SendFailure[];
}

export interface Messaging {
  sendEachForMulticast(payload: MulticastPayload): Promise<MulticastResult>;
}

// ---------------------------------------------------------------------------
// Clock — docs/00 §0.5: nothing here calls `Date.now()`/`new Date()` directly;
// every function that needs "now" takes it via this port instead.
// ---------------------------------------------------------------------------

export interface Clock {
  now(): Date;
}

// ---------------------------------------------------------------------------
// The bundle the composition root (`index.ts`) assembles once per invocation
// and hands to handlers. Individual handlers accept `Pick<Deps, ...>` of only
// what they actually use, so the signature documents the real dependency.
// ---------------------------------------------------------------------------

export interface Deps {
  db: Db;
  messaging: Messaging;
  clock: Clock;
}

// ---------------------------------------------------------------------------
// Neutral Firestore-trigger event envelopes. The composition root converts a
// real `QueryDocumentSnapshot` / `Change<QueryDocumentSnapshot>` into one of
// these (after validating with the matching `@pm/core` zod schema) so that
// nothing under `handlers/` needs to import `firebase-functions/v2/firestore`.
// ---------------------------------------------------------------------------

export interface DocCreatedEvent<T> {
  id: string;
  path: string;
  data: T;
}

export interface DocUpdatedEvent<T> {
  id: string;
  path: string;
  before: T;
  after: T;
}
