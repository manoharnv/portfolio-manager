import { approvalGate, collarState, isExpired, rejectProposal, secondsUntil } from './proposals';
import { buildConfig, buildProposal, buildSessionPayload, NOW, isoPlus } from '../test-utils';

const firestore = () => globalThis.__firestoreMock;

describe('rejectProposal', () => {
  it('writes exactly the diff firestore.rules permits, and nothing else', async () => {
    await rejectProposal('p1', 'u1', NOW);

    expect(firestore().updates).toEqual([
      {
        path: 'proposals/p1',
        data: { status: 'rejected', decidedBy: 'u1', decidedAt: NOW.toISOString() },
      },
    ]);
    // `hasOnly(['status','decidedBy','decidedAt'])` — three keys, no more.
    expect(Object.keys(firestore().updates[0]!.data).sort()).toEqual([
      'decidedAt',
      'decidedBy',
      'status',
    ]);
  });

  it('propagates a rules rejection rather than pretending it worked', async () => {
    firestore().failNextUpdate(new Error('permission-denied'));
    await expect(rejectProposal('p1', 'u1', NOW)).rejects.toThrow('permission-denied');
  });
});

describe('TTL', () => {
  it('counts down and clamps at zero', () => {
    expect(secondsUntil(isoPlus(120), NOW)).toBe(120);
    expect(secondsUntil(isoPlus(-1), NOW)).toBe(0);
    expect(secondsUntil('nonsense', NOW)).toBe(0);
  });

  it('marks an elapsed proposal expired', () => {
    expect(isExpired(buildProposal({ ttlExpiresAt: isoPlus(-1) }), NOW)).toBe(true);
    expect(isExpired(buildProposal({ ttlExpiresAt: isoPlus(1) }), NOW)).toBe(false);
  });
});

describe('collarState', () => {
  const config = buildConfig(); // priceCollarPct = 1

  it('collars a LIMIT order against its limit price, like guardrail 12', () => {
    const proposal = buildProposal();
    const state = collarState(proposal, config, 1500);
    expect(state.basis).toBe('limit');
    expect(state.reference).toBe(1500);
    expect(state.deviationPct).toBeCloseTo(0);
    expect(state.within).toBe(true);
  });

  it('fails a LIMIT order once the live price leaves the collar', () => {
    const state = collarState(buildProposal(), config, 1600);
    expect(state.deviationPct).toBeCloseTo(6.25);
    expect(state.within).toBe(false);
  });

  it('measures a MARKET order as drift from the proposal price', () => {
    const proposal = buildProposal({
      order: {
        symbol: { exchange: 'NSE', segment: 'EQ', tradingSymbol: 'INFY' },
        side: 'BUY',
        quantity: 10,
        orderType: 'MARKET',
        product: 'DELIVERY',
        validity: 'DAY',
      },
    });
    expect(collarState(proposal, config, 1500).basis).toBe('proposal-ltp');
    expect(collarState(proposal, config, 1500).within).toBe(true);
    expect(collarState(proposal, config, 1800).within).toBe(false);
  });

  it('fails closed with no config or no usable quote', () => {
    expect(collarState(buildProposal(), undefined, 1500).within).toBe(false);
    expect(collarState(buildProposal(), config, undefined).within).toBe(false);
    expect(collarState(buildProposal(), config, 0).within).toBe(false);
    expect(collarState(buildProposal(), config, Number.NaN).within).toBe(false);
  });

  it('uses the ceiling-clamped collar percentage', () => {
    const wide = buildConfig({
      guardrails: { ...config.guardrails, priceCollarPct: 5 },
    });
    expect(collarState(buildProposal(), wide, 1500).pct).toBe(5);
  });
});

describe('approvalGate', () => {
  const base = {
    proposal: buildProposal(),
    config: buildConfig(),
    session: buildSessionPayload(),
    backendReachable: true,
    liveLtp: 1500,
    now: NOW,
  };

  it('approves when everything is green', () => {
    const gate = approvalGate(base);
    expect(gate.canApprove).toBe(true);
    expect(gate.blocks).toEqual([]);
    expect(gate.secondsRemaining).toBe(300);
  });

  it('blocks with no config at all', () => {
    const gate = approvalGate({ ...base, config: undefined });
    expect(gate.canApprove).toBe(false);
    expect(gate.blocks.map((b) => b.reason)).toContain('NO_CONFIG');
  });

  it('blocks a non-pending proposal and says it is read-only when terminal', () => {
    const gate = approvalGate({ ...base, proposal: buildProposal({ status: 'filled' }) });
    expect(gate.blocks.find((b) => b.reason === 'NOT_PENDING')?.detail).toContain('read-only');

    const placing = approvalGate({ ...base, proposal: buildProposal({ status: 'placing' }) });
    expect(placing.blocks.find((b) => b.reason === 'NOT_PENDING')?.detail).toContain('already');
  });

  it('blocks an expired TTL', () => {
    const gate = approvalGate({
      ...base,
      proposal: buildProposal({ ttlExpiresAt: isoPlus(-1) }),
    });
    expect(gate.canApprove).toBe(false);
    expect(gate.blocks.map((b) => b.reason)).toContain('TTL_EXPIRED');
  });

  it('blocks on the kill switch and on trading being disabled', () => {
    expect(
      approvalGate({ ...base, config: buildConfig({ killSwitch: true }) }).blocks.map(
        (b) => b.reason,
      ),
    ).toContain('KILL_SWITCH');
    expect(
      approvalGate({ ...base, config: buildConfig({ tradingEnabled: false }) }).blocks.map(
        (b) => b.reason,
      ),
    ).toContain('TRADING_DISABLED');
  });

  it('blocks when the backend is unreachable', () => {
    const gate = approvalGate({ ...base, backendReachable: false });
    expect(gate.blocks.find((b) => b.reason === 'BACKEND_DOWN')?.detail).toContain(
      'execution unavailable',
    );
  });

  it('blocks on every flavour of missing broker session', () => {
    expect(approvalGate({ ...base, session: undefined }).blocks.map((b) => b.reason)).toContain(
      'NO_SESSION',
    );
    expect(
      approvalGate({
        ...base,
        session: buildSessionPayload({ activeBroker: null }),
      }).blocks.map((b) => b.reason),
    ).toContain('NO_SESSION');

    const needsLogin = buildSessionPayload();
    needsLogin.brokers[0]!.needsLogin = true;
    needsLogin.brokers[0]!.reason = 'token expired';
    expect(
      approvalGate({ ...base, session: needsLogin }).blocks.find((b) => b.reason === 'NO_SESSION')
        ?.detail,
    ).toBe('token expired');
  });

  it('blocks when the active broker has no entry at all', () => {
    const orphan = buildSessionPayload({ activeBroker: 'kite', brokers: [] });
    expect(
      approvalGate({ ...base, session: orphan }).blocks.find((b) => b.reason === 'NO_SESSION')
        ?.detail,
    ).toContain('kite');
  });

  it('blocks with no live quote — approval is gated on a fresh price', () => {
    const gate = approvalGate({ ...base, liveLtp: undefined });
    expect(gate.canApprove).toBe(false);
    expect(gate.blocks.map((b) => b.reason)).toContain('NO_QUOTE');
  });

  it('blocks when the live price is outside the collar and says to refresh', () => {
    const gate = approvalGate({ ...base, liveLtp: 1700 });
    const block = gate.blocks.find((b) => b.reason === 'PRICE_OUT_OF_COLLAR');
    expect(block?.detail).toContain('refresh');
    expect(block?.detail).toContain('your limit');
  });

  it('blocks when the engine precheck did not pass', () => {
    const gate = approvalGate({
      ...base,
      proposal: buildProposal({
        guardrailPrecheck: {
          passed: false,
          checks: [{ name: 'dailyNotional', ok: false, detail: 'over cap' }],
        },
      }),
    });
    expect(gate.blocks.map((b) => b.reason)).toContain('PRECHECK_FAILED');
  });

  it('reports every independent reason at once, not just the first', () => {
    const gate = approvalGate({
      ...base,
      config: buildConfig({ killSwitch: true, tradingEnabled: false }),
      backendReachable: false,
      liveLtp: undefined,
      session: undefined,
    });
    expect(gate.blocks.map((b) => b.reason).sort()).toEqual([
      'BACKEND_DOWN',
      'KILL_SWITCH',
      'NO_QUOTE',
      'NO_SESSION',
      'TRADING_DISABLED',
    ]);
  });
});
