/**
 * `orders/{id}` listeners — docs/03 §3.4. Read-only for the client by rule;
 * cancels go through `POST /v1/orders/:id/cancel`.
 */
import { useMemo } from 'react';
import { collection, doc, limit, orderBy, query, where } from 'firebase/firestore';
import { OrderRecordSchema, type OrderRecord, type OrderStatusCode } from '@pm/core';
import { getDb } from '../lib/firebase';
import { useDocumentSnapshot, useQuerySnapshot, type Subscription } from './firestore';

export const ORDERS_PAGE_SIZE = 100;

/** Statuses the broker can still act on — the only ones worth a Cancel button. */
export const CANCELLABLE: readonly OrderStatusCode[] = ['SUBMITTED', 'OPEN', 'PARTIAL'];

export function isCancellable(order: OrderRecord): boolean {
  return CANCELLABLE.includes(order.status);
}

export function useOrders(uid: string | undefined): Subscription<OrderRecord[]> {
  const q = useMemo(() => {
    if (uid === undefined) return null;
    return query(
      collection(getDb(), 'orders'),
      where('uid', '==', uid),
      orderBy('updatedAt', 'desc'),
      limit(ORDERS_PAGE_SIZE),
    );
  }, [uid]);

  return useQuerySnapshot(q, OrderRecordSchema, 'order');
}

export function useOrder(id: string | undefined): Subscription<OrderRecord | undefined> {
  const ref = useMemo(() => (id === undefined ? null : doc(getDb(), 'orders', id)), [id]);
  return useDocumentSnapshot(ref, OrderRecordSchema, 'order');
}
