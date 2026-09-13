/**
 * THE APPROVAL SCREEN — docs/06 §6.3 (3) and §6.4.
 *
 * The one screen in this system where a human turns an intention into an
 * irreversible act, so the order of operations is fixed and not negotiable:
 *
 *     gate (fail closed) → biometric → confirm slide → POST execute
 *
 * The gate is computed from live data on every render (`approvalGate`), the
 * biometric is re-run for every attempt, the idempotency key is minted at the
 * moment of the slide, and `clientSeenLtp` is *the number on the screen* — not
 * a freshly-fetched one — so the backend's staleness guard is grading what the
 * human actually saw.
 */
import { useCallback, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import type { GuardrailCheck } from '@pm/core';
import { useApp } from '../../../src/AppContext';
import { Banner } from '../../../src/components/Banner';
import { ConfirmSlider } from '../../../src/components/ConfirmSlider';
import { Countdown } from '../../../src/components/Countdown';
import { EmptyState, Loading } from '../../../src/components/GlobalBanners';
import { GuardrailChecklist } from '../../../src/components/GuardrailChecklist';
import { Money } from '../../../src/components/Money';
import { useProposal } from '../../../src/hooks/useProposals';
import { useLiveQuote } from '../../../src/hooks/useLiveQuote';
import { backend } from '../../../src/lib/backend';
import {
  describeReason,
  isFailure,
  type ApiFailure,
  type ExecutePayload,
} from '../../../src/lib/api';
import { runBiometricGate } from '../../../src/lib/biometric';
import {
  driftPct,
  inr,
  istDateTime,
  orderLine,
  pct,
  qty,
  relativeAge,
  symbolLabel,
} from '../../../src/lib/format';
import { newIdempotencyKey } from '../../../src/lib/idempotency';
import { approvalGate, rejectProposal } from '../../../src/lib/proposals';
import { orderRoute } from '../../../src/lib/deeplink';
import { colors, font, radius, space } from '../../../src/theme';

type Phase = 'idle' | 'verified' | 'submitting' | 'placed';

export default function ProposalDetailScreen() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;
  const app = useApp();
  const router = useRouter();

  const { data: proposal, loading, error } = useProposal(id);

  const [phase, setPhase] = useState<Phase>('idle');
  const [gateError, setGateError] = useState<string | undefined>(undefined);
  const [failure, setFailure] = useState<ApiFailure | undefined>(undefined);
  const [placed, setPlaced] = useState<ExecutePayload | undefined>(undefined);
  const [rejectError, setRejectError] = useState<string | undefined>(undefined);

  const quote = useLiveQuote(proposal?.order.symbol, {
    holdings: app.holdings,
    positions: app.positions,
    enabled: proposal !== undefined && proposal.status === 'pending',
  });

  const gate = useMemo(
    () =>
      proposal === undefined
        ? undefined
        : approvalGate({
            proposal,
            config: app.config,
            session: app.session,
            backendReachable: app.backendReachable,
            liveLtp: quote.ltp,
            now: new Date(),
          }),
    [proposal, app.config, app.session, app.backendReachable, quote.ltp],
  );

  /** The client-side half of the checklist, rendered next to the engine's. */
  const clientChecks = useMemo<GuardrailCheck[]>(() => {
    if (gate === undefined) return [];
    const blocked = new Set(gate.blocks.map((b) => b.reason));
    const detailFor = (reason: string, pass: string) =>
      gate.blocks.find((b) => b.reason === reason)?.detail ?? pass;
    return [
      {
        name: 'ttl',
        ok: !blocked.has('TTL_EXPIRED'),
        detail: detailFor('TTL_EXPIRED', 'the proposal is still within its TTL'),
      },
      {
        name: 'killSwitch',
        ok: !blocked.has('KILL_SWITCH') && !blocked.has('TRADING_DISABLED'),
        detail: detailFor(
          blocked.has('KILL_SWITCH') ? 'KILL_SWITCH' : 'TRADING_DISABLED',
          'kill switch off and trading enabled',
        ),
      },
      {
        name: 'brokerSession',
        ok: !blocked.has('NO_SESSION'),
        detail: detailFor('NO_SESSION', 'the active broker has a valid session'),
      },
      {
        name: 'backendReachable',
        ok: !blocked.has('BACKEND_DOWN'),
        detail: detailFor('BACKEND_DOWN', 'the execution backend is answering'),
      },
      {
        name: 'priceCollar',
        ok: !blocked.has('PRICE_OUT_OF_COLLAR') && !blocked.has('NO_QUOTE'),
        detail: detailFor(
          blocked.has('NO_QUOTE') ? 'NO_QUOTE' : 'PRICE_OUT_OF_COLLAR',
          gate.collar.deviationPct === undefined
            ? 'live price within collar'
            : `${pct(gate.collar.deviationPct)} from ${
                gate.collar.basis === 'limit' ? 'the limit' : 'the proposal price'
              } (collar ±${gate.collar.pct}%)`,
        ),
      },
    ];
  }, [gate]);

  const verify = useCallback(async () => {
    setGateError(undefined);
    setFailure(undefined);
    const outcome = await runBiometricGate({
      required: app.effectiveConfig?.guardrails.requireBiometric ?? true,
      promptMessage: 'Confirm it is you approving this order',
    });
    if (!outcome.ok) {
      setPhase('idle');
      setGateError(outcome.detail);
      return;
    }
    setPhase('verified');
  }, [app.effectiveConfig]);

  const submit = useCallback(async () => {
    if (proposal === undefined || gate === undefined || !gate.canApprove) return;
    const clientSeenLtp = quote.ltp;
    if (clientSeenLtp === undefined) {
      setGateError('the live price disappeared before the slide completed — nothing was sent');
      setPhase('idle');
      return;
    }
    setPhase('submitting');
    const result = await backend().executeProposal(proposal.id, {
      idempotencyKey: newIdempotencyKey(),
      clientSeenLtp,
    });
    if (isFailure(result)) {
      // A burned key means the approval already landed — that is a success
      // with a different shape, not a second chance to place an order.
      if (result.reason === 'IDEMPOTENT_REPLAY') {
        setPhase('placed');
        setFailure(result);
        return;
      }
      setPhase('idle');
      setFailure(result);
      return;
    }
    const { ok: _ok, ...payload } = result;
    setPlaced(payload);
    setFailure(undefined);
    setPhase('placed');
  }, [proposal, gate, quote.ltp]);

  const onReject = useCallback(async () => {
    if (proposal === undefined || app.uid === undefined) return;
    setRejectError(undefined);
    try {
      await rejectProposal(proposal.id, app.uid, new Date());
      if (router.canGoBack()) router.back();
    } catch (caught) {
      setRejectError(caught instanceof Error ? caught.message : 'Could not reject this proposal.');
    }
  }, [proposal, app.uid, router]);

  if (loading) return <Loading label="Loading proposal…" />;
  if (error !== undefined) {
    return (
      <Banner
        tone="danger"
        title="Cannot show this proposal"
        message={error}
        testID="proposal-error"
      />
    );
  }
  if (proposal === undefined || gate === undefined) {
    return (
      <EmptyState title="Proposal not found" message="It may have been deleted or never existed." />
    );
  }

  const { order, marketContext, rationale } = proposal;
  const drift =
    quote.ltp === undefined ? undefined : driftPct(marketContext.ltpAtProposal, quote.ltp);
  const charges = marketContext.estimatedCharges ?? 0;
  const netValue =
    order.side === 'BUY'
      ? marketContext.estimatedValueInr + charges
      : marketContext.estimatedValueInr - charges;
  const failureCopy = failure === undefined ? undefined : describeReason(failure.reason);
  const readOnly = proposal.status !== 'pending';

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      testID="proposal-detail"
    >
      {/* ---- the order ---------------------------------------------------- */}
      <View style={styles.card}>
        <View style={styles.headline}>
          <Text
            style={[styles.side, { color: order.side === 'BUY' ? colors.buy : colors.sell }]}
            testID="detail-side"
          >
            {order.side}
          </Text>
          <Text style={styles.qty}>{qty(order.quantity)}</Text>
          <Text style={styles.symbol}>{symbolLabel(order.symbol)}</Text>
        </View>
        <Text style={styles.orderLine}>{orderLine(order)}</Text>
        <View style={styles.metaRow}>
          <Text style={styles.metaKey}>Book</Text>
          <Text style={styles.metaValue}>
            {proposal.bookId} · {proposal.horizon}
          </Text>
        </View>
        <View style={styles.metaRow}>
          <Text style={styles.metaKey}>Strategy</Text>
          <Text style={styles.metaValue}>{proposal.strategyId}</Text>
        </View>
        <View style={styles.metaRow}>
          <Text style={styles.metaKey}>Status</Text>
          <Text style={styles.metaValue} testID="detail-status">
            {proposal.status}
          </Text>
        </View>
        <View style={styles.metaRow}>
          <Text style={styles.metaKey}>Expires</Text>
          <Countdown ttlExpiresAt={proposal.ttlExpiresAt} testID="detail-countdown" />
        </View>
      </View>

      {/* ---- the why ------------------------------------------------------ */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Why</Text>
        <Text style={styles.rationale} testID="detail-rationale">
          {rationale.summary}
        </Text>
        {rationale.confidence === undefined ? null : (
          <Text style={styles.confidence}>confidence: {rationale.confidence}</Text>
        )}
        <Text style={styles.captured}>proposed {istDateTime(proposal.createdAt)}</Text>
      </View>

      {/* ---- market context ------------------------------------------------ */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Market context</Text>
        <View style={styles.metaRow}>
          <Text style={styles.metaKey}>LTP at proposal</Text>
          <Text style={styles.metaValue}>{inr(marketContext.ltpAtProposal)}</Text>
        </View>
        <View style={styles.metaRow}>
          <Text style={styles.metaKey}>LTP now</Text>
          <Text style={styles.metaValue} testID="detail-live-ltp">
            {quote.ltp === undefined
              ? quote.cachedLtp === undefined
                ? 'no quote'
                : `${inr(quote.cachedLtp)} (stale)`
              : inr(quote.ltp)}
          </Text>
        </View>
        <View style={styles.metaRow}>
          <Text style={styles.metaKey}>Drift</Text>
          <Text
            style={[
              styles.metaValue,
              drift !== undefined && Math.abs(drift) > gate.collar.pct ? styles.bad : undefined,
            ]}
            testID="detail-drift"
          >
            {drift === undefined ? '—' : `${drift >= 0 ? '+' : ''}${pct(drift)}`}
          </Text>
        </View>
        <View style={styles.metaRow}>
          <Text style={styles.metaKey}>Quote age</Text>
          <Text style={styles.metaValue}>
            {quote.ageSeconds === undefined ? '—' : relativeAge(quote.ageSeconds)}
          </Text>
        </View>
        <View style={styles.metaRow}>
          <Text style={styles.metaKey}>Est. value</Text>
          <Money amount={marketContext.estimatedValueInr} size={font.small} />
        </View>
        <View style={styles.metaRow}>
          <Text style={styles.metaKey}>Est. charges</Text>
          <Money amount={charges} size={font.small} />
        </View>
        <View style={styles.metaRow}>
          <Text style={styles.metaKey}>Est. net</Text>
          <Money amount={netValue} size={font.small} bold testID="detail-net" />
        </View>
        <Pressable
          accessibilityRole="button"
          onPress={() => void quote.refresh()}
          style={styles.refresh}
          testID="refresh-quote"
        >
          <Text style={styles.refreshText}>
            {quote.refreshing ? 'Refreshing…' : 'Refresh quote'}
          </Text>
        </Pressable>
      </View>

      {/* ---- guardrails ---------------------------------------------------- */}
      <GuardrailChecklist
        title="Engine precheck"
        checks={proposal.guardrailPrecheck.checks}
        testID="engine-checklist"
      />
      <GuardrailChecklist title="Now" checks={clientChecks} testID="live-checklist" />

      {/* ---- result -------------------------------------------------------- */}
      {placed !== undefined ? (
        <Banner
          tone="ok"
          title="Order placed"
          message={`${placed.status} · broker order ${placed.brokerOrderId}`}
          actionLabel="Open order"
          onAction={() => router.push(orderRoute(placed.orderId))}
          testID="execute-success"
        />
      ) : null}

      {failure !== undefined && failureCopy !== undefined ? (
        <>
          <Banner
            tone={failure.reason === 'IDEMPOTENT_REPLAY' ? 'ok' : failureCopy.tone}
            title={failureCopy.title}
            message={`${failure.detail}${failureCopy.action === undefined ? '' : ` ${failureCopy.action}`}`}
            actionLabel={failure.reason === 'PRICE_MOVED' ? 'Refresh quote' : undefined}
            onAction={
              failure.reason === 'PRICE_MOVED'
                ? () => {
                    setFailure(undefined);
                    setPhase('idle');
                    void quote.refresh();
                  }
                : undefined
            }
            testID={`execute-${failure.reason}`}
          />
          {failure.failedChecks === undefined ? null : (
            <GuardrailChecklist
              title="Failed checks"
              checks={failure.failedChecks}
              testID="failed-checks"
            />
          )}
        </>
      ) : null}

      {gateError === undefined ? null : (
        <Banner tone="danger" title="Not approved" message={gateError} testID="gate-error" />
      )}
      {rejectError === undefined ? null : (
        <Banner
          tone="danger"
          title="Reject failed"
          message={rejectError}
          testID="detail-reject-error"
        />
      )}

      {/* ---- the act ------------------------------------------------------- */}
      {readOnly ? (
        <Banner
          tone="info"
          title={`This proposal is ${proposal.status}`}
          message="Read-only. Nothing on this screen can place an order."
          testID="read-only"
        />
      ) : (
        <View style={styles.actions}>
          {gate.canApprove ? null : (
            <View style={styles.blocks} testID="approve-blocks">
              {gate.blocks.map((block) => (
                <Text key={block.reason} style={styles.blockText} testID={`block-${block.reason}`}>
                  ✗ {block.detail}
                </Text>
              ))}
            </View>
          )}

          {phase === 'placed' ? null : phase === 'verified' || phase === 'submitting' ? (
            <ConfirmSlider
              label={`Slide to ${order.side} ${qty(order.quantity)} ${order.symbol.tradingSymbol} at ${
                quote.ltp === undefined ? '—' : inr(quote.ltp)
              }`}
              confirmingLabel="Placing…"
              disabled={!gate.canApprove}
              busy={phase === 'submitting'}
              onConfirm={() => void submit()}
              testID="confirm-slider"
            />
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: !gate.canApprove }}
              disabled={!gate.canApprove}
              onPress={() => void verify()}
              style={[styles.approve, gate.canApprove ? styles.approveOn : styles.approveOff]}
              testID="approve-button"
            >
              <Text
                style={[
                  styles.approveText,
                  gate.canApprove ? styles.approveTextOn : styles.approveTextOff,
                ]}
              >
                {gate.canApprove ? 'Approve…' : 'Approve unavailable'}
              </Text>
            </Pressable>
          )}

          <Pressable
            accessibilityRole="button"
            onPress={() => void onReject()}
            style={styles.reject}
            testID="detail-reject"
          >
            <Text style={styles.rejectText}>Reject</Text>
          </Pressable>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: space.md, paddingBottom: space.xxl },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: space.md,
    marginBottom: space.md,
  },
  cardTitle: { color: colors.text, fontSize: font.body, fontWeight: '700', marginBottom: space.sm },
  headline: { flexDirection: 'row', alignItems: 'baseline', gap: space.sm },
  side: { fontSize: font.h2, fontWeight: '900' },
  qty: { color: colors.text, fontSize: font.h2, fontWeight: '700' },
  symbol: { color: colors.text, fontSize: font.h2, fontWeight: '700' },
  orderLine: { color: colors.textMuted, fontSize: font.small, marginTop: space.xs },
  metaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 3,
  },
  metaKey: { color: colors.textMuted, fontSize: font.small },
  metaValue: { color: colors.text, fontSize: font.small, fontWeight: '600' },
  bad: { color: colors.danger },
  rationale: { color: colors.text, fontSize: font.body, lineHeight: 22 },
  confidence: { color: colors.textMuted, fontSize: font.small, marginTop: space.sm },
  captured: { color: colors.textMuted, fontSize: font.small, marginTop: space.xs },
  refresh: { marginTop: space.sm, minHeight: font.minTouchTarget, justifyContent: 'center' },
  refreshText: { color: colors.accent, fontSize: font.body, fontWeight: '700' },
  actions: { marginTop: space.sm },
  blocks: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: space.md,
    marginBottom: space.sm,
  },
  blockText: { color: colors.danger, fontSize: font.small, lineHeight: 20 },
  approve: {
    minHeight: 64,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
  },
  approveOn: { borderColor: colors.ok, backgroundColor: colors.surfaceAlt },
  approveOff: { borderColor: colors.disabled, backgroundColor: colors.surface },
  approveText: { fontSize: font.body, fontWeight: '800' },
  approveTextOn: { color: colors.ok },
  approveTextOff: { color: colors.disabled },
  reject: {
    marginTop: space.md,
    minHeight: font.minTouchTarget,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rejectText: { color: colors.sell, fontSize: font.body, fontWeight: '700' },
});
