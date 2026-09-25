/** Money, rendered one way everywhere. Colour only ever encodes sign. */
import { StyleSheet, Text, type TextStyle } from 'react-native';
import { colors, font } from '../theme';
import { inr, inrSigned, inrWhole } from '../lib/format';

export interface MoneyProps {
  amount: number;
  /** `signed` colours by sign and prefixes `+`; used for P&L. */
  variant?: 'plain' | 'signed' | 'whole' | undefined;
  size?: number | undefined;
  bold?: boolean | undefined;
  testID?: string | undefined;
}

export function Money(props: MoneyProps) {
  const variant = props.variant ?? 'plain';
  const text =
    variant === 'signed'
      ? inrSigned(props.amount)
      : variant === 'whole'
        ? inrWhole(props.amount)
        : inr(props.amount);

  const style: TextStyle = {
    fontSize: props.size ?? font.body,
    fontWeight: props.bold === true ? '700' : '500',
    color:
      variant === 'signed'
        ? props.amount > 0
          ? colors.ok
          : props.amount < 0
            ? colors.sell
            : colors.text
        : colors.text,
  };

  return (
    <Text testID={props.testID} style={[styles.base, style]}>
      {text}
    </Text>
  );
}

const styles = StyleSheet.create({
  base: { fontVariant: ['tabular-nums'] },
});
