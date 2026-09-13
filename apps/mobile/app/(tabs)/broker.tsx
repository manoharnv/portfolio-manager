/**
 * Broker Connect — docs/06 §6.3 (5).
 *
 * Daily login per broker, static-IP health, last-connected time, and the active
 * broker. The app never holds a broker credential: it asks the backend for a
 * login URL, opens it, and forwards only the short-lived `request_token`.
 *
 * **Switching the active broker is not wired.** `config.activeBroker` is
 * explicitly un-writable by the client (firestore.rules) and the backend
 * exposes no route for it today — the only `/v1/config/*` route is
 * `killswitch` (apps/backend/src/http/app.ts). Rather than invent a contract or
 * write a field the rules will bounce, the control says so plainly. See README
 * "Blocked on the backend".
 */
import { useCallback, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { Broker } from '@pm/core';
import { useApp } from '../../src/AppContext';
import { Banner } from '../../src/components/Banner';
import { mergeBrokerViews } from '../../src/hooks/useBrokerSessions';
import { backend } from '../../src/lib/backend';
import { describeReason } from '../../src/lib/api';
import { runBrokerLogin } from '../../src/lib/brokerLogin';
import { istDateTime, istTime } from '../../src/lib/format';
import { colors, font, radius, space } from '../../src/theme';

export default function BrokerScreen() {
  const app = useApp();
  const [busy, setBusy] = useState<Broker | undefined>(undefined);
  const [message, setMessage] = useState<
    { tone: 'ok' | 'danger' | 'warn'; title: string; body: string } | undefined
  >(undefined);

  const connect = useCallback(
    async (broker: Broker) => {
      setBusy(broker);
      setMessage(undefined);
      const result = await runBrokerLogin(broker, { api: backend() });
      setBusy(undefined);
      if (result.ok) {
        setMessage({
          tone: 'ok',
          title: `${broker} connected`,
          body: `Session valid until ${istTime(result.expiresAt)}.`,
        });
        await app.refreshSession();
        return;
      }
      const title =
        result.reason === 'CANCELLED'
          ? 'Login cancelled'
          : result.reason === 'NO_REQUEST_TOKEN'
            ? 'No request token'
            : result.reason === 'VERIFY_LIVE'
              ? 'Not enabled yet'
              : describeReason(result.reason).title;
      setMessage({
        tone: result.reason === 'CANCELLED' ? 'warn' : 'danger',
        title,
        body: result.detail,
      });
    },
    [app],
  );

  const views = mergeBrokerViews(app.brokerDocs, app.session);

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      testID="broker-screen"
      refreshControl={
        <RefreshControl
          refreshing={false}
          onRefresh={() => void app.refreshSession()}
          tintColor={colors.textMuted}
        />
      }
    >
      {message === undefined ? null : (
        <Banner
          tone={message.tone}
          title={message.title}
          message={message.body}
          testID="broker-message"
        />
      )}

      {views.map((view) => (
        <View key={view.broker} style={styles.card} testID={`broker-${view.broker}`}>
          <View style={styles.header}>
            <Text style={styles.name}>{view.broker.toUpperCase()}</Text>
            {view.isActive ? (
              <Text style={styles.activeChip} testID={`broker-${view.broker}-active`}>
                ACTIVE
              </Text>
            ) : null}
          </View>

          <Row
            k="Session"
            v={view.needsLogin ? (view.reason ?? 'needs today’s login') : 'connected'}
            tone={view.needsLogin ? 'bad' : 'good'}
          />
          <Row
            k="Expires"
            v={
              view.expiresAt === null || view.expiresAt === undefined
                ? '—'
                : istTime(view.expiresAt)
            }
          />
          <Row
            k="Last connected"
            v={
              view.lastConnectedAt === null || view.lastConnectedAt === undefined
                ? 'never'
                : istDateTime(view.lastConnectedAt)
            }
          />
          <Row
            k="Static IP"
            v={view.staticIpOk ? 'allowlisted' : 'not confirmed'}
            tone={view.staticIpOk ? 'good' : 'bad'}
          />

          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: busy !== undefined || !app.backendReachable }}
            disabled={busy !== undefined || !app.backendReachable}
            onPress={() => void connect(view.broker)}
            style={[
              styles.connect,
              busy !== undefined || !app.backendReachable ? styles.connectOff : styles.connectOn,
            ]}
            testID={`connect-${view.broker}`}
          >
            <Text style={styles.connectText}>
              {busy === view.broker
                ? 'Opening broker login…'
                : !app.backendReachable
                  ? 'Backend unreachable'
                  : view.needsLogin
                    ? `Connect ${view.broker} for today`
                    : `Re-connect ${view.broker}`}
            </Text>
          </Pressable>
        </View>
      ))}

      <View style={styles.card}>
        <Text style={styles.name}>Active broker</Text>
        <Text style={styles.note} testID="switch-broker-note">
          Switching between Dhan and Kite is not available from the app. `config.activeBroker` is
          not client-writable (firestore.rules) and the backend exposes no route to change it yet —
          the only `/v1/config/*` route is the kill switch. Change it on the backend, then pull to
          refresh here.
        </Text>
      </View>
    </ScrollView>
  );
}

function Row({ k, v, tone }: { k: string; v: string; tone?: 'good' | 'bad' | undefined }) {
  return (
    <View style={styles.row}>
      <Text style={styles.k}>{k}</Text>
      <Text
        style={[styles.v, tone === 'good' ? styles.good : tone === 'bad' ? styles.bad : undefined]}
        numberOfLines={2}
      >
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
  header: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginBottom: space.sm },
  name: { color: colors.text, fontSize: font.h2, fontWeight: '800' },
  activeChip: {
    color: colors.bg,
    backgroundColor: colors.accent,
    fontSize: font.small,
    fontWeight: '800',
    paddingHorizontal: space.sm,
    paddingVertical: 2,
    borderRadius: radius.pill,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
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
  good: { color: colors.ok },
  bad: { color: colors.warn },
  connect: {
    marginTop: space.md,
    minHeight: 56,
    borderRadius: radius.md,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  connectOn: { borderColor: colors.accent, backgroundColor: colors.surfaceAlt },
  connectOff: { borderColor: colors.disabled, backgroundColor: colors.surface },
  connectText: { color: colors.text, fontSize: font.body, fontWeight: '700' },
  note: { color: colors.textMuted, fontSize: font.small, lineHeight: 19, marginTop: space.xs },
});
