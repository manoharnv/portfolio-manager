/**
 * One row of the inbox (docs/06 §6.3 (2)): symbol, side, qty, order type,
 * estimated value, a one-line rationale and the live TTL countdown.
 *
 * Reject is inline and deliberately low-friction — saying "no" should be easy.
 * Approve is *not* here at all; it only exists on the detail screen behind a
 * biometric and a slide (docs/06 §6.1).
 */
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Proposal } from '@pm/core';
import { colors, font, radius, space } from '../theme';
import { orderLine, qty, symbolLabel } from '../lib/format';
import { Countdown } from './Countdown';
import { Money } from './Money';

export interface ProposalCardProps {
  proposal: Proposal;
  onOpen: (id: string) => void;
  onReject: (id: string) => void;
  rejecting?: boolean | undefined;
  testID?: string | undefined;
}

export function ProposalCard(props: ProposalCardProps) {
  const { proposal } = props;
  const sideColor = proposal.order.side === 'BUY' ? colors.buy : colors.sell;

  return (
    <View style={styles.card} testID={props.testID ?? `proposal-${proposal.id}`}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open ${proposal.order.side} ${proposal.order.quantity} ${proposal.order.symbol.tradingSymbol}`}
        onPress={() => props.onOpen(proposal.id)}
        style={styles.body}
        testID={`proposal-${proposal.id}-open`}
      >
        <View style={styles.headerRow}>
          <Text style={[styles.side, { color: sideColor }]}>{proposal.order.side}</Text>
          <Text style={styles.symbol}>{symbolLabel(proposal.order.symbol)}</Text>
          <Text style={styles.qty}>×{qty(proposal.order.quantity)}</Text>
          <View style={styles.spacer} />
          <Countdown
            ttlExpiresAt={proposal.ttlExpiresAt}
            testID={`proposal-${proposal.id}-countdown`}
          />
        </View>

        <Text style={styles.orderLine}>{orderLine(proposal.order)}</Text>

        <View style={styles.valueRow}>
          <Text style={styles.metaKey}>Est. value</Text>
          <Money
            amount={proposal.marketContext.estimatedValueInr}
            variant="whole"
            size={font.small}
            testID={`proposal-${proposal.id}-value`}
          />
        </View>

        <Text numberOfLines={2} style={styles.rationale}>
          {proposal.rationale.summary}
        </Text>

        <Text style={styles.book}>
          {proposal.bookId} · {proposal.strategyId}
        </Text>
      </Pressable>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Reject ${proposal.order.side} ${proposal.order.symbol.tradingSymbol}`}
        accessibilityState={{ disabled: props.rejecting === true }}
        disabled={props.rejecting === true}
        onPress={() => props.onReject(proposal.id)}
        style={styles.reject}
        testID={`proposal-${proposal.id}-reject`}
      >
        <Text style={styles.rejectText}>{props.rejecting === true ? 'Rejecting…' : 'Reject'}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    marginBottom: space.sm,
    overflow: 'hidden',
  },
  body: { padding: space.md },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  side: { fontSize: font.body, fontWeight: '900' },
  symbol: { color: colors.text, fontSize: font.body, fontWeight: '700' },
  qty: { color: colors.textMuted, fontSize: font.body },
  spacer: { flex: 1 },
  orderLine: { color: colors.textMuted, fontSize: font.small, marginTop: space.xs },
  valueRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: space.sm },
  metaKey: { color: colors.textMuted, fontSize: font.small },
  rationale: { color: colors.text, fontSize: font.small, marginTop: space.sm, lineHeight: 18 },
  book: { color: colors.textMuted, fontSize: font.small, marginTop: space.xs },
  reject: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    minHeight: font.minTouchTarget,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rejectText: { color: colors.sell, fontSize: font.body, fontWeight: '700' },
});
