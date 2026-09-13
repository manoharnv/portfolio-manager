/**
 * The live TTL countdown. Once the TTL elapses the timer is *replaced*, not
 * left ticking at zero — docs/06 §6.5, "an expired proposal opens read-only".
 */
import { StyleSheet, Text, View } from 'react-native';
import { colors, font, radius, space } from '../theme';
import { duration } from '../lib/format';
import { useCountdown } from '../hooks/useCountdown';

/** Under this many seconds the countdown turns red. */
export const URGENT_SECONDS = 30;

export interface CountdownProps {
  ttlExpiresAt: string;
  /** Rendered instead of the timer once expired. */
  expiredLabel?: string | undefined;
  testID?: string | undefined;
}

export function Countdown(props: CountdownProps) {
  const { secondsRemaining, expired } = useCountdown(props.ttlExpiresAt);

  if (expired) {
    return (
      <View style={[styles.pill, styles.expired]} testID={props.testID}>
        <Text style={styles.expiredText}>{props.expiredLabel ?? 'expired'}</Text>
      </View>
    );
  }

  const urgent = secondsRemaining <= URGENT_SECONDS;
  return (
    <View
      style={[styles.pill, urgent ? styles.urgent : styles.normal]}
      testID={props.testID}
      accessibilityLabel={`expires in ${duration(secondsRemaining)}`}
    >
      <Text style={[styles.text, urgent ? styles.urgentText : styles.normalText]}>
        {duration(secondsRemaining)}
      </Text>
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
  normal: { borderColor: colors.border, backgroundColor: colors.surfaceAlt },
  urgent: { borderColor: colors.danger, backgroundColor: colors.surfaceAlt },
  expired: { borderColor: colors.disabled, backgroundColor: colors.surfaceAlt },
  text: { fontSize: font.small, fontWeight: '700', fontVariant: ['tabular-nums'] },
  normalText: { color: colors.textMuted },
  urgentText: { color: colors.danger },
  expiredText: { fontSize: font.small, fontWeight: '700', color: colors.disabled },
});
