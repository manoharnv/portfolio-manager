/**
 * The two Firestore listener primitives every domain hook is built on.
 *
 * Both decode through the same zod schemas the backend writes with
 * (`@pm/core`), so a document that does not match the data model is surfaced as
 * an error rather than rendered — docs/00 §0.7.1, fail closed. A malformed
 * proposal must never reach the approval screen looking approvable.
 *
 * **Callers must memoise the ref/query.** The subscription effect keys on its
 * identity, so building a fresh `doc(...)` on every render re-subscribes in a
 * loop. Every domain hook in this directory wraps it in `useMemo(…, [uid])`.
 */
import { useEffect, useState } from 'react';
import {
  onSnapshot,
  type DocumentReference,
  type FirestoreError,
  type Query,
} from 'firebase/firestore';
import { log } from '../lib/log';

/**
 * The slice of a zod schema these hooks actually use. Structural rather than
 * `ZodType<T>` so `T` infers from the schema that is passed in without every
 * call site having to restate it.
 */
export interface Decoder<T> {
  safeParse(
    data: unknown,
  ): { success: true; data: T } | { success: false; error: { issues: unknown[] } };
}

export interface Subscription<T> {
  data: T;
  loading: boolean;
  error: string | undefined;
  /** true ⇒ served from the in-memory cache, not the server (docs/06 §6.6). */
  fromCache: boolean;
}

function messageOf(error: FirestoreError | Error): string {
  return 'code' in error && typeof error.code === 'string'
    ? `${error.code}: ${error.message}`
    : error.message;
}

/** Subscribe to one document. `ref === null` means "not ready yet" (no uid). */
export function useDocumentSnapshot<T>(
  ref: DocumentReference | null,
  schema: Decoder<T>,
  label: string,
): Subscription<T | undefined> {
  const [state, setState] = useState<Subscription<T | undefined>>({
    data: undefined,
    loading: ref !== null,
    error: undefined,
    fromCache: false,
  });

  useEffect(() => {
    if (ref === null) {
      setState({ data: undefined, loading: false, error: undefined, fromCache: false });
      return;
    }
    setState((prev) => ({ ...prev, loading: true }));
    return onSnapshot(
      ref,
      (snapshot) => {
        if (!snapshot.exists()) {
          setState({
            data: undefined,
            loading: false,
            error: undefined,
            fromCache: snapshot.metadata.fromCache,
          });
          return;
        }
        const parsed = schema.safeParse({ id: snapshot.id, ...snapshot.data() });
        if (!parsed.success) {
          log.error(`${label} document does not match the schema`, {
            id: snapshot.id,
            issues: parsed.error.issues.length,
          });
          setState({
            data: undefined,
            loading: false,
            error: `${label} document is malformed and cannot be trusted`,
            fromCache: snapshot.metadata.fromCache,
          });
          return;
        }
        setState({
          data: parsed.data,
          loading: false,
          error: undefined,
          fromCache: snapshot.metadata.fromCache,
        });
      },
      (error) => {
        setState({
          data: undefined,
          loading: false,
          error: messageOf(error),
          fromCache: false,
        });
      },
    );
    // `ref` identity is stable per the memo in each domain hook.
  }, [ref, schema, label]);

  return state;
}

/**
 * Subscribe to a query. Malformed documents are dropped from the list *and*
 * reported, rather than poisoning the whole screen — one bad audit row should
 * not hide the other 49.
 */
export function useQuerySnapshot<T>(
  query: Query | null,
  schema: Decoder<T>,
  label: string,
): Subscription<T[]> {
  const [state, setState] = useState<Subscription<T[]>>({
    data: [],
    loading: query !== null,
    error: undefined,
    fromCache: false,
  });

  useEffect(() => {
    if (query === null) {
      setState({ data: [], loading: false, error: undefined, fromCache: false });
      return;
    }
    setState((prev) => ({ ...prev, loading: true }));
    return onSnapshot(
      query,
      (snapshot) => {
        const rows: T[] = [];
        let dropped = 0;
        for (const docSnap of snapshot.docs) {
          const parsed = schema.safeParse({ id: docSnap.id, ...docSnap.data() });
          if (parsed.success) rows.push(parsed.data);
          else dropped += 1;
        }
        if (dropped > 0) log.error(`${label}: dropped malformed documents`, { dropped });
        setState({
          data: rows,
          loading: false,
          error: dropped > 0 ? `${dropped} ${label} record(s) are malformed and hidden` : undefined,
          fromCache: snapshot.metadata.fromCache,
        });
      },
      (error) => {
        setState({ data: [], loading: false, error: messageOf(error), fromCache: false });
      },
    );
  }, [query, schema, label]);

  return state;
}
