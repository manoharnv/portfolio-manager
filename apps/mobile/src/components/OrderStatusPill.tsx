/** Broker order status, colour-coded. One glance should say "is it done?". */
import { StyleSheet, Text, View } from 'react-native';
import type { OrderStatusCode } from '@pm/core';
import { colors, font, radius, space } from '../theme';

const TONE: Record<OrderStatusCode, string> = {
  SUBMITTED: colors.accent,
  OPEN: colors.accent,
  PARTIAL: colors.warn,
  COMPLETE: colors.ok,
  CANCELLED: colors.textMuted,
  REJECTED: colors.danger,
  EXPIRED: colors.textMuted,
  UNKNOWN: colors.warn,
};

export interface OrderStatusPillProps {
  status: OrderStatusCode;
  testID?: string | undefined;
}

export function OrderStatusPill(props: OrderStatusPillProps) {
  const color = TONE[props.status] ?? colors.textMuted;
  return (
    <View style={[styles.pill, { borderColor: color }]} testID={props.testID}>
      <Text style={[styles.text, { color }]}>{props.status}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
    borderRadius: radius.pill,
    borderWidth: 1,
    alignSelf: 'flex-start',
  },
  text: { fontSize: font.small, fontWeight: '700', letterSpacing: 0.5 },
});
