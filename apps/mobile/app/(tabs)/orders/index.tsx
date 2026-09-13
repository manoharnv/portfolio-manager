/**
 * Orders / activity — docs/06 §6.3 (4). Read-only by rule: `orders/{id}` is
 * backend-owned, which is what makes it tamper-evident (docs/07 §7.7).
 */
import { useCallback } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import type { OrderRecord } from '@pm/core';
import { useApp } from '../../../src/AppContext';
import { Banner } from '../../../src/components/Banner';
import { EmptyState, Loading } from '../../../src/components/GlobalBanners';
import { Money } from '../../../src/components/Money';
import { OrderStatusPill } from '../../../src/components/OrderStatusPill';
import { useOrders } from '../../../src/hooks/useOrders';
import { istDateTime, qty, symbolLabel } from '../../../src/lib/format';
import { orderRoute } from '../../../src/lib/deeplink';
import { colors, font, radius, space } from '../../../src/theme';

export default function OrdersScreen() {
  const { uid } = useApp();
  const router = useRouter();
  const orders = useOrders(uid);

  const renderItem = useCallback(
    ({ item }: { item: OrderRecord }) => (
      <Pressable
        accessibilityRole="button"
        onPress={() => router.push(orderRoute(item.id))}
        style={styles.row}
        testID={`order-${item.id}`}
      >
        <View style={styles.rowTop}>
          <Text
            style={[styles.side, { color: item.order.side === 'BUY' ? colors.buy : colors.sell }]}
          >
            {item.order.side}
          </Text>
          <Text style={styles.symbol}>{symbolLabel(item.order.symbol)}</Text>
          <Text style={styles.qty}>×{qty(item.order.quantity)}</Text>
          <View style={styles.spacer} />
          <OrderStatusPill status={item.status} testID={`order-${item.id}-status`} />
        </View>
        <View style={styles.rowBottom}>
          <Text style={styles.meta}>
            {qty(item.filledQty)}/{qty(item.order.quantity)} filled
            {item.avgFillPrice === null ? '' : ' @ '}
          </Text>
          {item.avgFillPrice === null ? null : (
            <Money amount={item.avgFillPrice} size={font.small} />
          )}
          <View style={styles.spacer} />
          <Text style={styles.meta}>{istDateTime(item.updatedAt)}</Text>
        </View>
        {item.rejectionReason === null ? null : (
          <Text style={styles.rejection}>{item.rejectionReason}</Text>
        )}
      </Pressable>
    ),
    [router],
  );

  if (orders.loading) return <Loading label="Loading orders…" />;

  return (
    <View style={styles.screen} testID="orders-screen">
      <FlatList
        data={orders.data}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          orders.error === undefined ? null : (
            <Banner tone="warn" title="Some orders are hidden" message={orders.error} />
          )
        }
        ListEmptyComponent={
          <EmptyState title="No orders yet" message="Approved proposals appear here." />
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  list: { padding: space.md, paddingBottom: space.xxl },
  row: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: space.md,
    marginBottom: space.sm,
    minHeight: font.minTouchTarget,
  },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  rowBottom: { flexDirection: 'row', alignItems: 'center', gap: space.xs, marginTop: space.xs },
  side: { fontSize: font.body, fontWeight: '900' },
  symbol: { color: colors.text, fontSize: font.body, fontWeight: '700' },
  qty: { color: colors.textMuted, fontSize: font.body },
  spacer: { flex: 1 },
  meta: { color: colors.textMuted, fontSize: font.small },
  rejection: { color: colors.danger, fontSize: font.small, marginTop: space.xs },
});
