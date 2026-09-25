/**
 * One capital sleeve (docs/10 §10.3): what it is allowed to spend, what it has
 * spent, and what it has made. The deployed bar is the "it physically cannot
 * spend another book's capital" idea, made visible.
 */
import { StyleSheet, Text, View } from 'react-native';
import { availableBudget, type Book } from '@pm/core';
import { colors, font, radius, space } from '../theme';
import { inrWhole, pct } from '../lib/format';
import { Money } from './Money';

export interface BookCardProps {
  book: Book;
  testID?: string | undefined;
}

export function BookCard(props: BookCardProps) {
  const { book } = props;
  const headroom = availableBudget(book);
  const usedPct =
    book.allocatedCapitalInr > 0
      ? Math.min(100, (book.deployedInr / book.allocatedCapitalInr) * 100)
      : 0;

  return (
    <View style={styles.card} testID={props.testID ?? `book-${book.id}`}>
      <View style={styles.header}>
        <Text style={styles.label}>{book.label}</Text>
        <Text style={[styles.state, book.enabled ? styles.stateOn : styles.stateOff]}>
          {book.enabled ? 'on' : 'paused'}
        </Text>
      </View>

      <View style={styles.barTrack}>
        <View style={[styles.barFill, { width: `${usedPct}%` }]} />
      </View>

      <View style={styles.row}>
        <Text style={styles.meta}>
          {inrWhole(book.deployedInr)} of {inrWhole(book.allocatedCapitalInr)} deployed ·{' '}
          {pct(book.allocationPct, 0)} allocation
        </Text>
      </View>
      <View style={styles.row}>
        <Text style={styles.metaKey}>Headroom</Text>
        <Money amount={headroom} variant="whole" size={font.small} />
      </View>
      <View style={styles.row}>
        <Text style={styles.metaKey}>Realised P&amp;L</Text>
        <Money amount={book.realizedPnlInr} variant="signed" size={font.small} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: space.md,
    marginBottom: space.sm,
  },
  header: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: space.sm },
  label: { color: colors.text, fontSize: font.body, fontWeight: '700' },
  state: { fontSize: font.small, fontWeight: '700' },
  stateOn: { color: colors.ok },
  stateOff: { color: colors.textMuted },
  barTrack: {
    height: 6,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.pill,
    overflow: 'hidden',
    marginBottom: space.sm,
  },
  barFill: { height: 6, backgroundColor: colors.accent },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 2,
  },
  meta: { color: colors.textMuted, fontSize: font.small },
  metaKey: { color: colors.textMuted, fontSize: font.small },
});
