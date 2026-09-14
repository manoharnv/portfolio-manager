/**
 * `books/{uid}/books/{bookId}` — the capital sleeves (docs/10 §10.3).
 *
 * Read-only by rule: `deployedInr` and `realizedPnlInr` are reconstructed from
 * the ledger by the backend, so a client write here could let a book claim
 * budget it has not earned (firestore.rules, docs/10 §10.8).
 */
import { useMemo } from 'react';
import { collection, query } from 'firebase/firestore';
import { BookSchema, availableBudget, type Book, type BookId } from '@pm/core';
import { getDb } from '../lib/firebase';
import { useQuerySnapshot, type Subscription } from './firestore';

/**
 * `scalp` is deliberately absent: the scalp book cannot wait for a biometric
 * tap (docs/10 §10.1) and mandates are deferred, so showing it would advertise
 * a capability this app does not have.
 */
export const VISIBLE_BOOKS: readonly BookId[] = ['long_term', 'swing', 'day_trade'];

export const BOOK_ORDER: Record<BookId, number> = {
  long_term: 0,
  swing: 1,
  day_trade: 2,
  scalp: 3,
};

export function visibleBooks(books: readonly Book[]): Book[] {
  return books
    .filter((b) => VISIBLE_BOOKS.includes(b.id))
    .sort((a, b) => BOOK_ORDER[a.id] - BOOK_ORDER[b.id]);
}

export function bookHeadroomInr(book: Book): number {
  return availableBudget(book);
}

export function useBooks(uid: string | undefined): Subscription<Book[]> {
  const q = useMemo(() => {
    if (uid === undefined) return null;
    return query(collection(getDb(), 'books', uid, 'books'));
  }, [uid]);

  return useQuerySnapshot(q, BookSchema, 'book');
}
