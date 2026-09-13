import { describe, expect, it } from 'vitest';

import { FakeDb, FakeMessaging } from '../test-utils/fakes.js';
import { makeProposal } from '../test-utils/fixtures.js';
import { onProposalCreated } from './onProposalCreated.js';

function deps() {
  return { db: new FakeDb(), messaging: new FakeMessaging() };
}

describe('onProposalCreated', () => {
  it('pushes "New proposal" to every fcmToken for a pending proposal', async () => {
    const d = deps();
    d.db.seed('users/u1', { fcmTokens: ['t1'] });
    const proposal = makeProposal();

    const result = await onProposalCreated(d, { id: 'p1', path: 'proposals/p1', data: proposal });

    expect(result).toEqual({ sent: true });
    expect(d.messaging.sent).toHaveLength(1);
    expect(d.messaging.sent[0]?.notification.body).toBe('BUY 10 INFY proposed — review');
    expect(d.messaging.sent[0]?.data['deepLink']).toBe('pm://proposals/p1');
    expect(d.messaging.sent[0]?.data['proposalId']).toBe('p1');
  });

  it('no tokens on the user doc → no send', async () => {
    const d = deps();
    d.db.seed('users/u1', { fcmTokens: [] });
    const proposal = makeProposal();

    const result = await onProposalCreated(d, { id: 'p1', path: 'proposals/p1', data: proposal });

    expect(result).toEqual({ sent: false });
    expect(d.messaging.sent).toHaveLength(0);
  });

  it('non-pending proposal → no send', async () => {
    const d = deps();
    d.db.seed('users/u1', { fcmTokens: ['t1'] });
    const proposal = makeProposal({ status: 'approved' });

    const result = await onProposalCreated(d, { id: 'p1', path: 'proposals/p1', data: proposal });

    expect(result).toEqual({ sent: false });
    expect(d.messaging.sent).toHaveLength(0);
  });
});
