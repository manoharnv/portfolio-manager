import { describe, expect, it } from 'vitest';

import { FakeClock, FakeDb, FakeMessaging } from '../test-utils/fakes.js';
import { makeProposal } from '../test-utils/fixtures.js';
import { expireProposals, expireProposalsExpiringSoon } from './expireProposals.js';

const NOW = '2026-01-13T05:00:00.000Z';

function deps() {
  return { db: new FakeDb(), messaging: new FakeMessaging(), clock: new FakeClock(new Date(NOW)) };
}

describe('expireProposals', () => {
  it('expires proposals due at or before now (the boundary is inclusive) and leaves others alone', async () => {
    const d = deps();
    d.db.seed(
      'proposals/due-exact',
      makeProposal({ id: 'due-exact', status: 'pending', ttlExpiresAt: NOW }),
    );
    d.db.seed(
      'proposals/due-past',
      makeProposal({ id: 'due-past', status: 'pending', ttlExpiresAt: '2026-01-13T04:00:00.000Z' }),
    );
    d.db.seed(
      'proposals/not-due',
      makeProposal({ id: 'not-due', status: 'pending', ttlExpiresAt: '2026-01-13T05:00:00.001Z' }),
    );
    d.db.seed(
      'proposals/already-approved',
      makeProposal({
        id: 'already-approved',
        status: 'approved',
        ttlExpiresAt: '2026-01-13T04:00:00.000Z',
      }),
    );

    const result = await expireProposals(d);

    expect(result).toEqual({ expiredCount: 2 });
    expect(d.db.get('proposals/due-exact')?.['status']).toBe('expired');
    expect(d.db.get('proposals/due-past')?.['status']).toBe('expired');
    expect(d.db.get('proposals/not-due')?.['status']).toBe('pending');
    expect(d.db.get('proposals/already-approved')?.['status']).toBe('approved');
  });

  it('does nothing when no proposals are due', async () => {
    const d = deps();
    d.db.seed(
      'proposals/not-due',
      makeProposal({ id: 'not-due', status: 'pending', ttlExpiresAt: '2026-01-13T06:00:00.000Z' }),
    );

    const result = await expireProposals(d);

    expect(result).toEqual({ expiredCount: 0 });
  });

  it('appends an append-only proposal.expired audit entry per expired proposal, actor system', async () => {
    const d = deps();
    d.db.seed(
      'proposals/p1',
      makeProposal({ id: 'p1', uid: 'u1', status: 'pending', ttlExpiresAt: NOW }),
    );

    await expireProposals(d);

    const auditDocs = d.db.entries().filter(([path]) => path.startsWith('auditLog/'));
    expect(auditDocs).toHaveLength(1);
    const [, data] = auditDocs[0]!;
    expect(data['type']).toBe('proposal.expired');
    expect(data['actor']).toBe('system');
    expect(data['refId']).toBe('p1');
    expect(data['uid']).toBe('u1');
    expect(typeof data['id']).toBe('string');
  });

  it('paginates past the 200-doc page size', async () => {
    const d = deps();
    for (let i = 0; i < 250; i += 1) {
      const id = `p${String(i).padStart(4, '0')}`;
      d.db.seed(
        `proposals/${id}`,
        makeProposal({ id, status: 'pending', ttlExpiresAt: '2026-01-13T04:00:00.000Z' }),
      );
    }

    const result = await expireProposals(d);

    expect(result).toEqual({ expiredCount: 250 });
    expect(d.db.queryCalls).toBeGreaterThanOrEqual(2);
    const stillPending = d.db
      .entries()
      .filter(([path, data]) => path.startsWith('proposals/') && data['status'] === 'pending');
    expect(stillPending).toHaveLength(0);
  });
});

describe('expireProposalsExpiringSoon', () => {
  it('pushes and stamps a proposal whose ttl lands in the 90s-150s window', async () => {
    const d = deps();
    d.db.seed('users/u1', { fcmTokens: ['t1'] });
    d.db.seed(
      'proposals/p1',
      makeProposal({
        id: 'p1',
        uid: 'u1',
        status: 'pending',
        ttlExpiresAt: '2026-01-13T05:02:00.000Z',
      }),
    );

    const result = await expireProposalsExpiringSoon(d);

    expect(result).toEqual({ notifiedCount: 1 });
    expect(d.messaging.sent[0]?.notification.body).toBe('Proposal expires in 2 min');
    expect(d.db.get('proposals/p1')?.['expiringSoonNotifiedAt']).toBe(NOW);
  });

  it('is idempotent — does not re-notify a proposal already stamped', async () => {
    const d = deps();
    d.db.seed('users/u1', { fcmTokens: ['t1'] });
    d.db.seed('proposals/p1', {
      ...makeProposal({
        id: 'p1',
        uid: 'u1',
        status: 'pending',
        ttlExpiresAt: '2026-01-13T05:02:00.000Z',
      }),
      expiringSoonNotifiedAt: '2026-01-13T04:59:00.000Z',
    });

    const result = await expireProposalsExpiringSoon(d);

    expect(result).toEqual({ notifiedCount: 0 });
    expect(d.messaging.sent).toHaveLength(0);
  });

  it('stamps the proposal even when there is no token to send to (never retries forever)', async () => {
    const d = deps();
    d.db.seed('users/u1', { fcmTokens: [] });
    d.db.seed(
      'proposals/p1',
      makeProposal({
        id: 'p1',
        uid: 'u1',
        status: 'pending',
        ttlExpiresAt: '2026-01-13T05:02:00.000Z',
      }),
    );

    const result = await expireProposalsExpiringSoon(d);

    expect(result).toEqual({ notifiedCount: 0 });
    expect(d.db.get('proposals/p1')?.['expiringSoonNotifiedAt']).toBe(NOW);
  });

  it('ignores proposals outside the 90s-150s window', async () => {
    const d = deps();
    d.db.seed('users/u1', { fcmTokens: ['t1'] });
    d.db.seed(
      'proposals/too-soon',
      makeProposal({
        id: 'too-soon',
        uid: 'u1',
        status: 'pending',
        ttlExpiresAt: '2026-01-13T05:00:30.000Z',
      }),
    );
    d.db.seed(
      'proposals/too-late',
      makeProposal({
        id: 'too-late',
        uid: 'u1',
        status: 'pending',
        ttlExpiresAt: '2026-01-13T05:03:00.000Z',
      }),
    );

    const result = await expireProposalsExpiringSoon(d);

    expect(result).toEqual({ notifiedCount: 0 });
    expect(d.messaging.sent).toHaveLength(0);
  });
});
