/**
 * `proposals/{id}` listeners — docs/03 §3.3.
 *
 * The inbox query mirrors what firestore.rules will actually serve
 * (`isOwner(resource.data.uid)`), so the `where('uid','==',uid)` clause is not
 * cosmetic: without it the listener is rejected outright.
 */
import { useMemo } from 'react';
import { collection, doc, limit, orderBy, query, where } from 'firebase/firestore';
import { ProposalSchema, type Proposal } from '@pm/core';
import { getDb } from '../lib/firebase';
import { useDocumentSnapshot, useQuerySnapshot, type Subscription } from './firestore';

export const PENDING_PAGE_SIZE = 50;

export function usePendingProposals(uid: string | undefined): Subscription<Proposal[]> {
  const q = useMemo(() => {
    if (uid === undefined) return null;
    return query(
      collection(getDb(), 'proposals'),
      where('uid', '==', uid),
      where('status', '==', 'pending'),
      orderBy('ttlExpiresAt', 'asc'),
      limit(PENDING_PAGE_SIZE),
    );
  }, [uid]);

  return useQuerySnapshot(q, ProposalSchema, 'proposal');
}

export function useProposal(id: string | undefined): Subscription<Proposal | undefined> {
  const ref = useMemo(() => (id === undefined ? null : doc(getDb(), 'proposals', id)), [id]);
  return useDocumentSnapshot(ref, ProposalSchema, 'proposal');
}
