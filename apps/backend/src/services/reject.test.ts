import { beforeEach, describe, expect, it } from 'vitest';
import { createAuditWriter } from './audit.js';
import { createRejectService, type RejectService } from './reject.js';
import { FakeAuditLog, FakeProposalRepo, FixedClock, SeqIdGenerator } from '../test-utils/fakes.js';
import { MARKET_OPEN_NOW, makeProposal } from '../test-utils/fixtures.js';

interface Harness {
  service: RejectService;
  proposals: FakeProposalRepo;
  auditLog: FakeAuditLog;
}

function harness(): Harness {
  const clock = new FixedClock(MARKET_OPEN_NOW);
  const ids = new SeqIdGenerator();
  const proposals = new FakeProposalRepo([makeProposal()]);
  const auditLog = new FakeAuditLog();
  const service = createRejectService({
    proposals,
    clock,
    audit: createAuditWriter({ audit: auditLog, ids, clock, ip: '203.0.113.7' }),
  });
  return { service, proposals, auditLog };
}

let h: Harness;
beforeEach(() => {
  h = harness();
});

describe('rejectProposal', () => {
  it('rejects a pending proposal and records who decided', async () => {
    const result = await h.service.rejectProposal({
      uid: 'u1',
      proposalId: 'p1',
      reason: 'not convinced',
    });

    expect(result).toEqual({ ok: true, status: 'rejected' });
    expect(h.proposals.statusOf('p1')).toBe('rejected');
    expect(h.proposals.docs.get('p1')).toMatchObject({
      decidedBy: 'u1',
      decidedAt: MARKET_OPEN_NOW,
      failureReason: 'not convinced',
    });
    expect(h.auditLog.byType('proposal.rejected')[0]).toMatchObject({
      actor: 'app-user',
      refId: 'p1',
    });
  });

  it('works without a reason', async () => {
    expect(await h.service.rejectProposal({ uid: 'u1', proposalId: 'p1' })).toEqual({
      ok: true,
      status: 'rejected',
    });
    expect(h.auditLog.byType('proposal.rejected')[0]?.detail['reason']).toBe('rejected by user');
  });

  it('refuses a caller who does not own the proposal', async () => {
    const result = await h.service.rejectProposal({ uid: 'intruder', proposalId: 'p1' });

    expect(result).toMatchObject({ ok: false, reason: 'UNAUTHORIZED' });
    expect(h.proposals.statusOf('p1')).toBe('pending');
    expect(h.auditLog.events).toHaveLength(0);
  });

  it('reports a missing proposal', async () => {
    expect(await h.service.rejectProposal({ uid: 'u1', proposalId: 'nope' })).toMatchObject({
      ok: false,
      reason: 'STALE_PROPOSAL',
    });
  });

  it.each(['approved', 'placing', 'placed', 'filled', 'rejected', 'expired'] as const)(
    'refuses to reject a proposal already in status %s',
    async (status) => {
      h.proposals.put(makeProposal({ status }));
      expect(await h.service.rejectProposal({ uid: 'u1', proposalId: 'p1' })).toMatchObject({
        ok: false,
        reason: 'STALE_PROPOSAL',
      });
    },
  );

  it('loses gracefully to a concurrent transition', async () => {
    const stale = new FakeProposalRepo([makeProposal()]);
    // The proposal moves after the read but before the compare-and-set.
    const originalTransition = stale.transition.bind(stale);
    stale.transition = async (id, from, to, patch) => {
      stale.put(makeProposal({ status: 'expired' }));
      return originalTransition(id, from, to, patch);
    };
    const clock = new FixedClock(MARKET_OPEN_NOW);
    const auditLog = new FakeAuditLog();
    const service = createRejectService({
      proposals: stale,
      clock,
      audit: createAuditWriter({ audit: auditLog, ids: new SeqIdGenerator(), clock, ip: '' }),
    });

    expect(await service.rejectProposal({ uid: 'u1', proposalId: 'p1' })).toMatchObject({
      ok: false,
      reason: 'STALE_PROPOSAL',
    });
    expect(auditLog.events).toHaveLength(0);
  });
});
