/**
 * Thin, untested Firebase Admin SDK implementation of the ports in `../ports.js`.
 * Excluded from coverage (vitest.config.ts) — everything with actual branching
 * logic (handlers/, notify.ts, catalogue.ts) is tested against
 * `../test-utils/fakes.ts` instead (docs/00 §0.5: no network in unit tests).
 * This is the only file in the package allowed to import `firebase-admin`.
 *
 * Admin init is lazy and idempotent (`getApps().length === 0 ? initializeApp()
 * : getApp()`), and nothing here runs at module load — only inside the
 * `createAdmin*` factories, which `index.ts` calls once per invocation. That
 * is what lets the built bundle be imported with no credentials present (see
 * the bundle-load smoke test in functions/README.md).
 */
import { getApp, getApps, initializeApp } from 'firebase-admin/app';
import type { DocumentData, Query, WhereFilterOp } from 'firebase-admin/firestore';
import { getFirestore } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';

import type {
  Clock,
  Db,
  DbBatch,
  Messaging,
  MulticastPayload,
  MulticastResult,
  QueryFilter,
  QueryResultDoc,
} from '../ports.js';

function app() {
  return getApps().length === 0 ? initializeApp() : getApp();
}

function firestore() {
  return getFirestore(app());
}

/**
 * The ports speak `Record<string, unknown>` (honest — we don't know the shape
 * until a `@pm/core` zod schema validates it); the Admin SDK wants its own
 * `DocumentData`. Both describe "a plain JSON-ish object", so this boundary
 * cast is the one place that gap is bridged.
 */
function asDocumentData(data: Record<string, unknown>): DocumentData {
  return data as DocumentData;
}

export function createAdminDb(): Db {
  return {
    async getDoc<T>(path: string): Promise<T | undefined> {
      const snap = await firestore().doc(path).get();
      return snap.exists ? (snap.data() as T) : undefined;
    },

    async setDoc(path: string, data: Record<string, unknown>): Promise<void> {
      await firestore().doc(path).set(asDocumentData(data));
    },

    async updateDoc(path: string, data: Record<string, unknown>): Promise<void> {
      await firestore().doc(path).update(asDocumentData(data));
    },

    async queryCollection<T>(
      path: string,
      filters: QueryFilter[],
      limit?: number,
    ): Promise<Array<QueryResultDoc<T>>> {
      let query: Query = firestore().collection(path);
      for (const filter of filters) {
        query = query.where(filter.field, filter.op as WhereFilterOp, filter.value);
      }
      if (limit !== undefined) {
        query = query.limit(limit);
      }
      const snap = await query.get();
      return snap.docs.map((doc) => ({ id: doc.id, path: doc.ref.path, data: doc.data() as T }));
    },

    async addDoc(collectionPath: string, data: Record<string, unknown>): Promise<string> {
      const ref = await firestore().collection(collectionPath).add(asDocumentData(data));
      return ref.id;
    },

    batch(): DbBatch {
      const writeBatch = firestore().batch();
      return {
        set(path: string, data: Record<string, unknown>): void {
          writeBatch.set(firestore().doc(path), asDocumentData(data));
        },
        update(path: string, data: Record<string, unknown>): void {
          writeBatch.update(firestore().doc(path), asDocumentData(data));
        },
        async commit(): Promise<void> {
          await writeBatch.commit();
        },
      };
    },
  };
}

export function createAdminMessaging(): Messaging {
  return {
    async sendEachForMulticast(payload: MulticastPayload): Promise<MulticastResult> {
      const response = await getMessaging(app()).sendEachForMulticast({
        tokens: payload.tokens,
        notification: payload.notification,
        data: payload.data,
      });

      const failures = response.responses.flatMap((result, index) => {
        if (result.success) return [];
        const token = payload.tokens[index];
        if (token === undefined) return [];
        return [{ token, code: result.error?.code ?? 'unknown' }];
      });

      return { failures };
    },
  };
}

export function createAdminClock(): Clock {
  return {
    now: () => new Date(),
  };
}
