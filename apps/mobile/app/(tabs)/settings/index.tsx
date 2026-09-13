/**
 * Settings — docs/06 §6.3 (6).
 *
 * Environment and active broker are shown but **not editable**: the rules
 * reject a diff that touches them and the backend re-clamps everything anyway
 * (docs/04 §4.8). Notification preferences live in `users/{uid}.prefs`, one of
 * the two client-owned fields.
 *
 * Per-strategy on/off and params go through `PATCH /v1/strategies/:id` —
 * `strategies/{uid}/defs` is read-only for the client. The master
 * `tradingEnabled` switch stays above them: it is the one that stops the engine
 * outright.
 */
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useApp } from '../../../src/AppContext';
import { Banner } from '../../../src/components/Banner';
import { Money } from '../../../src/components/Money';
import { useStrategies, type StrategyDef } from '../../../src/hooks/useStrategies';
import { signOut } from '../../../src/lib/auth';
import { ROUTES } from '../../../src/lib/deeplink';
import { istDateTime, pct } from '../../../src/lib/format';
import { formatParams, parseParams } from '../../../src/lib/strategyParams';
import { colors, font, radius, space } from '../../../src/theme';

export default function SettingsScreen() {
  const app = useApp();
  const router = useRouter();
  const strategies = useStrategies(app.uid);
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

      <View style={styles.card} testID="strategies-card">
        <Text style={styles.cardTitle}>Strategies</Text>
        {strategies.error === undefined ? null : (
          <Banner
            tone="danger"
            title="Strategy not updated"
            message={strategies.error}
            testID="strategy-error"
          />
        )}
        {strategies.defs.length === 0 ? (
          <Text style={styles.note} testID="no-strategies">
            The strategy engine has not registered any routines for this account yet.
          </Text>
        ) : (
          strategies.defs.map((def) => (
            <StrategyRow
              key={def.id}
              def={def}
              busy={strategies.pending === def.id}
              onPatch={strategies.patch}
            />
          ))
        )}
        <Text style={styles.note}>
          Per-strategy changes go through the backend; `strategies/{'{uid}'}/defs` is read-only for
          the client. The master switch above stops the engine outright.
        </Text>
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

/**
 * One strategy: an optimistic enabled toggle, and a params editor that will not
 * send anything that is not a plain JSON object within the size cap.
 */
function StrategyRow(props: {
  def: StrategyDef;
  busy: boolean;
  onPatch: (
    id: string,
    patch: { enabled?: boolean; params?: Record<string, unknown> },
  ) => Promise<boolean>;
}) {
  const { def } = props;
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(() => formatParams(def.params));
  const [paramsError, setParamsError] = useState<string | undefined>(undefined);
  const [savedAt, setSavedAt] = useState(false);

  const saveParams = useCallback(async () => {
    setSavedAt(false);
    const parsed = parseParams(text);
    if (!parsed.ok) {
      setParamsError(parsed.error);
      return;
    }
    setParamsError(undefined);
    const ok = await props.onPatch(def.id, { params: parsed.value });
    setSavedAt(ok);
  }, [text, props, def.id]);

  return (
    <View style={styles.strategy} testID={`strategy-${def.id}`}>
      <View style={styles.switchRow}>
        <View style={styles.switchLabel}>
          <Text style={styles.k}>{def.label ?? def.id}</Text>
          <Text style={styles.note}>{def.id}</Text>
        </View>
        <Switch
          accessibilityLabel={`${def.label ?? def.id} enabled`}
          testID={`strategy-${def.id}-enabled`}
          value={def.enabled}
          disabled={props.busy}
          onValueChange={(next) => void props.onPatch(def.id, { enabled: next })}
          trackColor={{ true: colors.ok, false: colors.disabled }}
        />
      </View>

      <Pressable
        accessibilityRole="button"
        onPress={() => setOpen((prev) => !prev)}
        style={styles.paramsToggle}
        testID={`strategy-${def.id}-params-toggle`}
      >
        <Text style={styles.linkText}>{open ? 'Hide params' : 'Edit params'}</Text>
      </Pressable>

      {open ? (
        <View>
          <TextInput
            accessibilityLabel={`${def.id} params`}
            testID={`strategy-${def.id}-params`}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
            defaultValue={text}
            onChangeText={setText}
            placeholder='{"rsiPeriod": 14}'
            placeholderTextColor={colors.textMuted}
            style={styles.paramsInput}
          />
          {paramsError === undefined ? null : (
            <Text style={styles.paramsError} testID={`strategy-${def.id}-params-error`}>
              {paramsError}
            </Text>
          )}
          {savedAt ? (
            <Text style={styles.paramsSaved} testID={`strategy-${def.id}-params-saved`}>
              Saved.
            </Text>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: props.busy }}
            disabled={props.busy}
            onPress={() => void saveParams()}
            style={styles.paramsSave}
            testID={`strategy-${def.id}-params-save`}
          >
            <Text style={styles.linkText}>{props.busy ? 'Saving…' : 'Save params'}</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
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
  strategy: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: space.sm,
    marginTop: space.sm,
  },
  paramsToggle: { minHeight: font.minTouchTarget, justifyContent: 'center' },
  paramsInput: {
    minHeight: 96,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    padding: space.md,
    color: colors.text,
    fontSize: font.small,
    backgroundColor: colors.surfaceAlt,
    textAlignVertical: 'top',
  },
  paramsError: { color: colors.danger, fontSize: font.small, marginTop: space.xs },
  paramsSaved: { color: colors.ok, fontSize: font.small, marginTop: space.xs },
  paramsSave: { minHeight: font.minTouchTarget, justifyContent: 'center' },
  signOut: {
    minHeight: font.minTouchTarget,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: space.lg,
  },
  signOutText: { color: colors.sell, fontSize: font.body, fontWeight: '700' },
});
