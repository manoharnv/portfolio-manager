/**
 * Order detail — status, fills, timestamps, and Cancel for an open order
 * (docs/06 §6.3 (4)). The cancel goes through `POST /v1/orders/:id/cancel`;
 * the app cannot touch `orders/{id}` directly.
 */
import { useCallback, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useApp } from '../../../src/AppContext';
import { Banner } from '../../../src/components/Banner';
import { EmptyState, Loading } from '../../../src/components/GlobalBanners';
import { Money } from '../../../src/components/Money';
import { OrderStatusPill } from '../../../src/components/OrderStatusPill';
import { isCancellable, useOrder } from '../../../src/hooks/useOrders';
import { backend } from '../../../src/lib/backend';
import { describeReason, isFailure } from '../../../src/lib/api';
import { istDateTime, orderLine, qty, symbolLabel } from '../../../src/lib/format';
import { colors, font, radius, space } from '../../../src/theme';

export default function OrderDetailScreen() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;
  const { backendReachable } = useApp();
  const { data: order, loading, error } = useOrder(id);

  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<
    { tone: 'ok' | 'danger'; title: string; message: string } | undefined
  >(undefined);

  const doCancel = useCallback(async () => {
    if (order === undefined) return;
    setBusy(true);
    const response = await backend().cancelOrder(order.id);
    setBusy(false);
    if (isFailure(response)) {
      const copy = describeReason(response.reason);
      setResult({ tone: 'danger', title: copy.title, message: response.detail });
      return;
    }
    setResult({
      tone: 'ok',
      title: 'Cancel requested',
      message: 'The broker was asked to cancel. Status updates arrive here live.',
    });
  }, [order]);

  const confirmCancel = useCallback(() => {
    Alert.alert('Cancel this order?', 'The broker may already have filled part of it.', [
      { text: 'Keep it', style: 'cancel' },
      { text: 'Cancel order', style: 'destructive', onPress: () => void doCancel() },
    ]);
  }, [doCancel]);

  if (loading) return <Loading label="Loading order…" />;
  if (error !== undefined) {
    return <Banner tone="danger" title="Cannot show this order" message={error} />;
  }
  if (order === undefined) {
    return <EmptyState title="Order not found" message="No order with that id belongs to you." />;
  }

  const cancellable = isCancellable(order);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} testID="order-detail">
      {result === undefined ? null : (
        <Banner
          tone={result.tone}
          title={result.title}
          message={result.message}
          testID="cancel-result"
        />
      )}

      <View style={styles.card}>
        <View style={styles.headline}>
          <Text
            style={[styles.side, { color: order.order.side === 'BUY' ? colors.buy : colors.sell }]}
          >
            {order.order.side}
          </Text>
          <Text style={styles.symbol}>{symbolLabel(order.order.symbol)}</Text>
          <View style={styles.spacer} />
          <OrderStatusPill status={order.status} testID="order-status" />
        </View>
        <Text style={styles.orderLine}>{orderLine(order.order)}</Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Fills</Text>
        <Row k="Filled" v={`${qty(order.filledQty)} of ${qty(order.order.quantity)}`} />
        <View style={styles.row}>
          <Text style={styles.k}>Avg price</Text>
          {order.avgFillPrice === null ? (
            <Text style={styles.v}>—</Text>
          ) : (
            <Money amount={order.avgFillPrice} size={font.small} testID="avg-fill-price" />
          )}
        </View>
        {order.rejectionReason === null ? null : (
          <Row k="Rejection" v={order.rejectionReason} bad />
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Trail</Text>
        <Row k="Book" v={`${order.bookId} · ${order.horizon}`} />
        <Row k="Broker" v={order.broker} />
        <Row k="Broker order id" v={order.brokerOrderId ?? '—'} />
        <Row k="Approved" v={`${istDateTime(order.approvedAt)} by ${order.approvedBy}`} />
        <Row
          k="Submitted"
          v={order.submittedAt === null ? 'not submitted' : istDateTime(order.submittedAt)}
        />
        <Row k="Updated" v={istDateTime(order.updatedAt)} />
        <Row k="IP used" v={order.ipUsed} />
        <Row k="Environment" v={order.environment} />
        <Row k="Proposal" v={order.proposalId} />
      </View>

      {cancellable ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: busy || !backendReachable }}
          disabled={busy || !backendReachable}
          onPress={confirmCancel}
          style={[styles.cancel, busy || !backendReachable ? styles.cancelOff : styles.cancelOn]}
          testID="cancel-order"
        >
          <Text style={styles.cancelText}>
            {busy
              ? 'Cancelling…'
              : backendReachable
                ? 'Cancel order'
                : 'Cancel unavailable — backend down'}
          </Text>
        </Pressable>
      ) : (
        <Text style={styles.note} testID="not-cancellable">
          {order.status} orders cannot be cancelled.
        </Text>
      )}
    </ScrollView>
  );
}

function Row({ k, v, bad }: { k: string; v: string; bad?: boolean | undefined }) {
  return (
    <View style={styles.row}>
      <Text style={styles.k}>{k}</Text>
      <Text style={[styles.v, bad === true ? styles.vBad : undefined]} numberOfLines={2}>
        {v}
      </Text>
    </View>
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
  headline: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  side: { fontSize: font.h2, fontWeight: '900' },
  symbol: { color: colors.text, fontSize: font.h2, fontWeight: '700' },
  spacer: { flex: 1 },
  orderLine: { color: colors.textMuted, fontSize: font.small, marginTop: space.xs },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 3,
    gap: space.md,
  },
  k: { color: colors.textMuted, fontSize: font.small },
  v: {
    color: colors.text,
    fontSize: font.small,
    fontWeight: '600',
    flexShrink: 1,
    textAlign: 'right',
  },
  vBad: { color: colors.danger },
  cancel: {
    minHeight: 56,
    borderRadius: radius.md,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelOn: { borderColor: colors.danger, backgroundColor: colors.surface },
  cancelOff: { borderColor: colors.disabled, backgroundColor: colors.surface },
  cancelText: { color: colors.danger, fontSize: font.body, fontWeight: '700' },
  note: { color: colors.textMuted, fontSize: font.small, textAlign: 'center' },
});
