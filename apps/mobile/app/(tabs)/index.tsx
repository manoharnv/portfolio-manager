/**
 * Dashboard — docs/06 §6.3 (1).
 *
 * Portfolio value, day P&L, the book sleeves, the active-broker chip with its
 * session status, the pending badge, and the kill switch: the one control on
 * this screen that can change the world, so it confirms both ways and goes
 * through the backend (`POST /v1/config/killswitch`), never a direct Firestore
 * write.
 */
import { useCallback, useState } from 'react';
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useApp } from '../../src/AppContext';
import { BookCard } from '../../src/components/BookCard';
import { Banner } from '../../src/components/Banner';
import { EmptyState } from '../../src/components/GlobalBanners';
import { Money } from '../../src/components/Money';
import { backend } from '../../src/lib/backend';
import { describeReason, isFailure } from '../../src/lib/api';
import { istTime, relativeAge } from '../../src/lib/format';
import { visibleBooks } from '../../src/hooks/useBooks';
import { ROUTES } from '../../src/lib/deeplink';
import { colors, font, radius, space } from '../../src/theme';

export default function DashboardScreen() {
  const app = useApp();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const killSwitch = app.config?.killSwitch === true;
  const pending = app.pendingProposals.length;
  const activeBroker = app.session?.activeBroker ?? null;
  const active = app.session?.brokers.find((b) => b.broker === activeBroker);

  const applyKillSwitch = useCallback(async (next: boolean) => {
    setBusy(true);
    setError(undefined);
    const result = await backend().setKillSwitch(
      next,
      next ? 'halted from the dashboard' : 'resumed from the dashboard',
    );
    setBusy(false);
    if (isFailure(result)) {
      setError(`${describeReason(result.reason).title}: ${result.detail}`);
    }
  }, []);

  const toggleKillSwitch = useCallback(() => {
    const next = !killSwitch;
    Alert.alert(
      next ? 'Halt all trading?' : 'Resume trading?',
      next
        ? 'The backend will refuse every order until you turn this off.'
        : 'Orders will be accepted again, subject to every other guardrail.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: next ? 'Halt trading' : 'Resume trading',
          style: next ? 'destructive' : 'default',
          onPress: () => void applyKillSwitch(next),
        },
      ],
    );
  }, [killSwitch, applyKillSwitch]);

  const books = visibleBooks(app.books);
  const summary = app.portfolioSummary;

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      testID="dashboard-screen"
      refreshControl={
        <RefreshControl
          refreshing={false}
          onRefresh={() => void app.refreshSession()}
          tintColor={colors.textMuted}
        />
      }
    >
      {error === undefined ? null : (
        <Banner
          tone="danger"
          title="Kill switch not changed"
          message={error}
          testID="killswitch-error"
        />
      )}

      <View style={styles.hero}>
        <Text style={styles.heroLabel}>Portfolio value</Text>
        <Money
          amount={summary.marketValueInr}
          variant="whole"
          size={font.h1}
          bold
          testID="portfolio-value"
        />
        <View style={styles.heroRow}>
          <Text style={styles.heroKey}>Day P&amp;L</Text>
          <Money amount={summary.dayPnlInr} variant="signed" testID="day-pnl" />
        </View>
        <View style={styles.heroRow}>
          <Text style={styles.heroKey}>Unrealised</Text>
          <Money amount={summary.unrealisedPnlInr} variant="signed" />
        </View>
        <View style={styles.heroRow}>
          <Text style={styles.heroKey}>Cash</Text>
          <Money amount={app.funds?.availableCash ?? 0} variant="whole" />
        </View>
        <Text style={styles.stale} testID="portfolio-age">
          {summary.updatedAt === undefined
            ? 'no cached portfolio yet'
            : `${summary.holdingsCount} holdings · updated ${relativeAge(
                (Date.now() - new Date(summary.updatedAt).getTime()) / 1000,
              )}`}
        </Text>
      </View>

      <Pressable
        accessibilityRole="button"
        onPress={() => router.push(ROUTES.broker)}
        style={styles.brokerChip}
        testID="broker-chip"
      >
        <Text style={styles.brokerName}>{activeBroker ?? 'no active broker'}</Text>
        <Text
          style={[
            styles.brokerStatus,
            active?.needsLogin === false ? styles.brokerOk : styles.brokerBad,
          ]}
        >
          {active === undefined
            ? 'session unknown — tap to connect'
            : active.needsLogin
              ? (active.reason ?? 'tap to connect for today')
              : `connected · expires ${active.expiresAt === undefined ? 'unknown' : istTime(active.expiresAt)}`}
        </Text>
      </Pressable>

      <Pressable
        accessibilityRole="button"
        onPress={() => router.push(ROUTES.proposals)}
        style={styles.pending}
        testID="pending-badge"
      >
        <Text style={styles.pendingCount}>{pending}</Text>
        <Text style={styles.pendingLabel}>
          {pending === 1 ? 'proposal waiting for you' : 'proposals waiting for you'}
        </Text>
      </Pressable>

      <Pressable
        accessibilityRole="switch"
        accessibilityState={{ checked: killSwitch, disabled: busy }}
        accessibilityLabel="Kill switch"
        disabled={busy}
        onPress={toggleKillSwitch}
        style={[styles.kill, killSwitch ? styles.killOn : styles.killOff]}
        testID="kill-switch"
      >
        <Text style={[styles.killTitle, killSwitch ? styles.killTitleOn : styles.killTitleOff]}>
          {killSwitch ? 'KILL SWITCH ON' : 'Kill switch off'}
        </Text>
        <Text style={styles.killHint}>
          {busy
            ? 'Talking to the backend…'
            : killSwitch
              ? 'Every order is refused. Tap to resume trading.'
              : 'Tap to halt all trading immediately.'}
        </Text>
      </Pressable>

      <Text style={styles.sectionTitle}>Books</Text>
      {books.length === 0 ? (
        <EmptyState
          title="No books yet"
          message="The backend provisions capital sleeves; none have been written for this account."
        />
      ) : (
        books.map((book) => <BookCard key={book.id} book={book} />)
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: space.md, paddingBottom: space.xxl },
  hero: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: space.lg,
    marginBottom: space.md,
  },
  heroLabel: { color: colors.textMuted, fontSize: font.small, marginBottom: space.xs },
  heroRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: space.sm,
  },
  heroKey: { color: colors.textMuted, fontSize: font.body },
  stale: { color: colors.textMuted, fontSize: font.small, marginTop: space.md },
  brokerChip: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: space.md,
    marginBottom: space.md,
    minHeight: font.minTouchTarget,
  },
  brokerName: {
    color: colors.text,
    fontSize: font.body,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  brokerStatus: { fontSize: font.small, marginTop: space.xs },
  brokerOk: { color: colors.ok },
  brokerBad: { color: colors.warn },
  pending: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: space.md,
    marginBottom: space.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: font.minTouchTarget,
  },
  pendingCount: { color: colors.accent, fontSize: font.h1, fontWeight: '800' },
  pendingLabel: { color: colors.text, fontSize: font.body, flex: 1 },
  kill: {
    borderRadius: radius.lg,
    borderWidth: 2,
    padding: space.lg,
    marginBottom: space.lg,
    minHeight: 88,
    justifyContent: 'center',
  },
  killOn: { borderColor: colors.danger, backgroundColor: '#2A1216' },
  killOff: { borderColor: colors.border, backgroundColor: colors.surface },
  killTitle: { fontSize: font.h2, fontWeight: '900', letterSpacing: 0.5 },
  killTitleOn: { color: colors.danger },
  killTitleOff: { color: colors.text },
  killHint: { color: colors.textMuted, fontSize: font.small, marginTop: space.xs },
  sectionTitle: {
    color: colors.text,
    fontSize: font.h2,
    fontWeight: '700',
    marginBottom: space.sm,
  },
});
