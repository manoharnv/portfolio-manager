/**
 * The listener primitives, driven through a mocked `onSnapshot`
 * (jest.setup.js). No network, no emulator — docs/00 §0.5.
 */
import { act, renderHook } from '@testing-library/react-native';
import { doc, collection, query } from 'firebase/firestore';
import { ProposalSchema } from '@pm/core';
import { useDocumentSnapshot, useQuerySnapshot } from './firestore';
import { buildProposal } from '../test-utils';

const fs = () => globalThis.__firestoreMock;

// Both refs are created ONCE: `useDocumentSnapshot`/`useQuerySnapshot` key
// their effect on ref identity, so every call site memoises (see the domain
// hooks). Building a fresh ref per render would re-subscribe forever.
const DOC_REF = doc({} as never, 'proposals', 'p1');
const QUERY_REF = query(collection({} as never, 'proposals'));

describe('useDocumentSnapshot', () => {
  it('starts loading and resolves with the decoded document', async () => {
    const { result } = await renderHook(() =>
      useDocumentSnapshot(DOC_REF, ProposalSchema, 'proposal'),
    );
    expect(result.current.loading).toBe(true);

    const proposal = buildProposal();
    await act(() => fs().emitDoc('proposals/p1', proposal));

    expect(result.current.loading).toBe(false);
    expect(result.current.data?.id).toBe('p1');
    expect(result.current.error).toBeUndefined();
  });

  it('reports a missing document as absent, not as an error', async () => {
    const { result } = await renderHook(() =>
      useDocumentSnapshot(DOC_REF, ProposalSchema, 'proposal'),
    );
    await act(() => fs().emitDoc('proposals/p1', undefined));

    expect(result.current.data).toBeUndefined();
    expect(result.current.error).toBeUndefined();
    expect(result.current.loading).toBe(false);
  });

  // docs/00 §0.7.1 — a malformed proposal must never reach the approval screen.
  it('refuses to hand back a document that does not match the schema', async () => {
    const { result } = await renderHook(() =>
      useDocumentSnapshot(DOC_REF, ProposalSchema, 'proposal'),
    );
    await act(() => fs().emitDoc('proposals/p1', { id: 'p1', nonsense: true }));

    expect(result.current.data).toBeUndefined();
    expect(result.current.error).toContain('malformed');
  });

  it('surfaces a permission error with its code', async () => {
    const { result } = await renderHook(() =>
      useDocumentSnapshot(DOC_REF, ProposalSchema, 'proposal'),
    );
    await act(() =>
      fs().emitError(
        'proposals/p1',
        Object.assign(new Error('Missing or insufficient permissions.'), {
          code: 'permission-denied',
        }),
      ),
    );
    expect(result.current.error).toBe('permission-denied: Missing or insufficient permissions.');
  });

  it('surfaces a plain Error without a code', async () => {
    const { result } = await renderHook(() =>
      useDocumentSnapshot(DOC_REF, ProposalSchema, 'proposal'),
    );
    await act(() => fs().emitError('proposals/p1', new Error('offline')));
    expect(result.current.error).toBe('offline');
  });

  it('reports cache-served snapshots so a stale screen can say so', async () => {
    const { result } = await renderHook(() =>
      useDocumentSnapshot(DOC_REF, ProposalSchema, 'proposal'),
    );
    await act(() => fs().emitDoc('proposals/p1', buildProposal(), { fromCache: true }));
    expect(result.current.fromCache).toBe(true);
  });

  it('subscribes to nothing when the ref is null, and unsubscribes on unmount', async () => {
    const nullRun = await renderHook(() => useDocumentSnapshot(null, ProposalSchema, 'proposal'));
    expect(nullRun.result.current.loading).toBe(false);

    const { unmount } = await renderHook(() =>
      useDocumentSnapshot(DOC_REF, ProposalSchema, 'proposal'),
    );
    expect(fs().listenerCount('proposals/p1')).toBe(1);
    await unmount();
    expect(fs().listenerCount('proposals/p1')).toBe(0);
  });
});

describe('useQuerySnapshot', () => {
  it('decodes every row', async () => {
    const { result } = await renderHook(() =>
      useQuerySnapshot(QUERY_REF, ProposalSchema, 'proposal'),
    );
    await act(() =>
      fs().emitCollection('proposals', [
        { id: 'p1', data: buildProposal({ id: 'p1' }) },
        { id: 'p2', data: buildProposal({ id: 'p2' }) },
      ]),
    );

    expect(result.current.data.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(result.current.error).toBeUndefined();
  });

  it('drops a malformed row and says how many it hid', async () => {
    const { result } = await renderHook(() =>
      useQuerySnapshot(QUERY_REF, ProposalSchema, 'proposal'),
    );
    await act(() =>
      fs().emitCollection('proposals', [
        { id: 'p1', data: buildProposal({ id: 'p1' }) },
        { id: 'p2', data: { broken: true } },
      ]),
    );

    expect(result.current.data).toHaveLength(1);
    expect(result.current.error).toContain('1 proposal record(s) are malformed');
  });

  it('reports an empty result as empty, not as loading forever', async () => {
    const { result } = await renderHook(() =>
      useQuerySnapshot(QUERY_REF, ProposalSchema, 'proposal'),
    );
    await act(() => fs().emitCollection('proposals', []));
    expect(result.current.data).toEqual([]);
    expect(result.current.loading).toBe(false);
  });

  it('surfaces a query error and empties the list', async () => {
    const { result } = await renderHook(() =>
      useQuerySnapshot(QUERY_REF, ProposalSchema, 'proposal'),
    );
    await act(() => fs().emitCollection('proposals', [{ id: 'p1', data: buildProposal() }]));
    await act(() => fs().emitError('proposals', new Error('index missing')));

    expect(result.current.data).toEqual([]);
    expect(result.current.error).toBe('index missing');
  });

  it('subscribes to nothing when the query is null', async () => {
    const { result } = await renderHook(() => useQuerySnapshot(null, ProposalSchema, 'proposal'));
    expect(result.current.loading).toBe(false);
    expect(result.current.data).toEqual([]);
  });
});
