/**
 * Settings — docs/06 §6.3 (6).
 *
 * Environment and active broker are shown but **not editable**: the rules
 * reject a diff that touches them and the backend re-clamps everything anyway
 * (docs/04 §4.8). Notification preferences live in `users/{uid}.prefs`, one of
 * the two client-owned fields.
 */
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useApp } from '../../../src/AppContext';
import { Banner } from '../../../src/components/Banner';
import { Money } from '../../../src/components/Money';
import { signOut } from '../../../src/lib/auth';
import { ROUTES } from '../../../src/lib/deeplink';
import { istDateTime, pct } from '../../../src/lib/format';
import { colors, font, radius, space } from '../../../src/theme';

export default function SettingsScreen() {
  const app = useApp();
  const router = useRouter();
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const config = app.config;

  const setTradingEnabled = useCallback(
    async (next: boolean) => {
      setBusy(true);
      setError(undefined);
      try {
        await app.updateConfig({ tradingEnabled: next }, new Date());
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Could not save that change.');
      } finally {
        setBusy(false);
      }
    },
    [app],
  );

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      testID="settings-screen"
    >
      {error === undefined ? null : (
        <Banner tone="danger" title="Not saved" message={error} testID="settings-error" />
      )}

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Account</Text>
        <Row k="Signed in as" v={app.user?.email ?? app.user?.displayName ?? '—'} />
        <Row k="uid" v={app.uid ?? '—'} />
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Environment</Text>
        <Row k="Environment" v={config?.environment ?? '—'} locked />
        <Row k="Active broker" v={config?.activeBroker ?? '—'} locked />
        <Text style={styles.note}>
          Both are backend-owned. The rules reject any client write that touches them.
        </Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Trading</Text>
        <View style={styles.switchRow}>
          <View style={styles.switchLabel}>
            <Text style={styles.k}>Strategy engine</Text>
            <Text style={styles.note}>
              Off pauses proposal generation. The kill switch on the dashboard is the stronger
              control — it refuses orders outright.
            </Text>
          </View>
          <Switch
            accessibilityLabel="Strategy engine enabled"
            testID="trading-enabled"
            value={config?.tradingEnabled ?? false}
            disabled={config === undefined || busy}
            onValueChange={(next) => void setTradingEnabled(next)}
            trackColor={{ true: colors.ok, false: colors.disabled }}
          />
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Capital</Text>
        <View style={styles.row}>
          <Text style={styles.k}>Total managed</Text>
          <Money amount={config?.totalManagedCapitalInr ?? 0} variant="whole" size={font.small} />
        </View>
        <Row k="Reserve" v={pct(config?.reservePct ?? 0, 0)} />
        <Row k="Last updated" v={config === undefined ? '—' : istDateTime(config.updatedAt)} />
      </View>

      <Pressable
        accessibilityRole="button"
        onPress={() => router.push(ROUTES.guardrails)}
        style={styles.link}
        testID="open-guardrails"
      >
        <Text style={styles.linkText}>Guardrails →</Text>
        <Text style={styles.note}>
          Order caps, collar, TTL, segments, products, allow/blocklists, biometric.
        </Text>
      </Pressable>

      <Pressable
        accessibilityRole="button"
        onPress={() => void signOut()}
        style={styles.signOut}
        testID="sign-out"
      >
        <Text style={styles.signOutText}>Sign out</Text>
      </Pressable>
    </ScrollView>
  );
}

function Row({ k, v, locked }: { k: string; v: string; locked?: boolean | undefined }) {
  return (
    <View style={styles.row}>
      <Text style={styles.k}>{k}</Text>
      <Text style={styles.v} numberOfLines={1}>
        {v}
        {locked === true ? '  🔒' : ''}
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
  note: { color: colors.textMuted, fontSize: font.small, lineHeight: 18, marginTop: space.xs },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  switchLabel: { flex: 1 },
  link: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: space.md,
    marginBottom: space.md,
    minHeight: font.minTouchTarget,
  },
  linkText: { color: colors.accent, fontSize: font.body, fontWeight: '700' },
  signOut: {
    minHeight: font.minTouchTarget,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: space.lg,
  },
  signOutText: { color: colors.sell, fontSize: font.body, fontWeight: '700' },
});
