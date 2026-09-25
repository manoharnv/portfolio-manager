/**
 * The "fail visible" primitive (docs/06 §6.1). Every refusal, every degraded
 * state and every global condition renders as one of these — never as a silent
 * disabled control.
 */
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, font, radius, space } from '../theme';

export type BannerTone = 'danger' | 'warn' | 'info' | 'ok';

const TONE_COLOR: Record<BannerTone, string> = {
  danger: colors.danger,
  warn: colors.warn,
  info: colors.accent,
  ok: colors.ok,
};

export interface BannerProps {
  tone: BannerTone;
  title: string;
  message?: string | undefined;
  /** Label for the inline action; omit for a purely informational banner. */
  actionLabel?: string | undefined;
  onAction?: (() => void) | undefined;
  testID?: string | undefined;
}

export function Banner(props: BannerProps) {
  const accent = TONE_COLOR[props.tone];
  return (
    <View
      accessibilityRole="alert"
      testID={props.testID}
      style={[styles.container, { borderLeftColor: accent }]}
    >
      <Text style={[styles.title, { color: accent }]}>{props.title}</Text>
      {props.message === undefined ? null : <Text style={styles.message}>{props.message}</Text>}
      {props.actionLabel === undefined || props.onAction === undefined ? null : (
        <Pressable
          accessibilityRole="button"
          onPress={props.onAction}
          style={styles.action}
          testID={props.testID === undefined ? undefined : `${props.testID}-action`}
        >
          <Text style={[styles.actionText, { color: accent }]}>{props.actionLabel}</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.surface,
    borderLeftWidth: 4,
    borderRadius: radius.md,
    padding: space.md,
    marginBottom: space.md,
  },
  title: { fontSize: font.body, fontWeight: '700' },
  message: { color: colors.textMuted, fontSize: font.small, marginTop: space.xs, lineHeight: 18 },
  action: {
    marginTop: space.sm,
    minHeight: font.minTouchTarget,
    justifyContent: 'center',
  },
  actionText: { fontSize: font.body, fontWeight: '700' },
});
