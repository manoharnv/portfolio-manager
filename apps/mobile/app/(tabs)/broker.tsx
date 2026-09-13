/**
 * Broker Connect — docs/06 §6.3 (5).
 *
 * Daily login per broker, static-IP health, last-connected time, and the active
 * broker. The app never holds a broker credential: it asks the backend for a
 * login URL, opens it, and forwards only the short-lived `request_token`.
 *
 * **Switching the active broker goes through the backend**, never Firestore:
 * `config.activeBroker` is un-writable by the client (firestore.rules), so
 * "Make active" calls `POST /v1/config/active-broker`. The backend refuses with
 * 409 `SESSION_INVALID` when the target broker has no session for today, and
 * the screen then offers to run that broker's login first.
 */
import { useCallback, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { Broker } from '@pm/core';
import { useApp } from '../../src/AppContext';
import { Banner } from '../../src/components/Banner';
import { mergeBrokerViews } from '../../src/hooks/useBrokerSessions';
import { backend } from '../../src/lib/backend';
import { describeReason, isFailure } from '../../src/lib/api';
import { runBrokerLogin } from '../../src/lib/brokerLogin';
import { istDateTime, istTime } from '../../src/lib/format';
import { colors, font, radius, space } from '../../src/theme';

interface ScreenMessage {
  tone: 'ok' | 'danger' | 'warn';
  title: string;
  body: string;
  /** Set on a 409: the broker whose daily login has to happen first. */
  connectFirst?: Broker | undefined;
}

export default function BrokerScreen() {
  const app = useApp();
  const [busy, setBusy] = useState<Broker | undefined>(undefined);
  const [switching, setSwitching] = useState<Broker | undefined>(undefined);
  const [message, setMessage] = useState<ScreenMessage | undefined>(undefined);

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

  /**
   * `POST /v1/config/active-broker`. A 409 is not an error to shrug at — it
   * means the target broker has no session today, so the banner turns into a
   * "connect first" action rather than a dead end.
   */
  const makeActive = useCallback(
    async (broker: Broker) => {
      setSwitching(broker);
      setMessage(undefined);
      const result = await backend().setActiveBroker(broker);
      setSwitching(undefined);

      if (!isFailure(result)) {
        setMessage({
          tone: 'ok',
          title: `${result.activeBroker} is now the active broker`,
          body: 'New proposals and every execution will route through it.',
        });
        await app.refreshSession();
        return;
      }
      setMessage({
        tone: result.reason === 'SESSION_INVALID' ? 'warn' : 'danger',
        title:
          result.reason === 'SESSION_INVALID'
            ? `${broker} is not connected today`
            : describeReason(result.reason).title,
        body: result.detail,
        ...(result.reason === 'SESSION_INVALID' ? { connectFirst: broker } : {}),
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
          actionLabel={
            message.connectFirst === undefined ? undefined : `Connect ${message.connectFirst} now`
          }
          onAction={
            message.connectFirst === undefined
              ? undefined
              : () => void connect(message.connectFirst as Broker)
          }
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

          {view.isActive ? (
            <Text style={styles.note} testID={`active-note-${view.broker}`}>
              Already the active broker — every proposal and execution routes through it.
            </Text>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: switching !== undefined || !app.backendReachable }}
              disabled={switching !== undefined || !app.backendReachable}
              onPress={() => void makeActive(view.broker)}
              style={[
                styles.makeActive,
                switching !== undefined || !app.backendReachable
                  ? styles.connectOff
                  : styles.makeActiveOn,
              ]}
              testID={`make-active-${view.broker}`}
            >
              <Text style={styles.makeActiveText}>
                {switching === view.broker
                  ? 'Switching…'
                  : !app.backendReachable
                    ? 'Backend unreachable'
                    : `Make ${view.broker} active`}
              </Text>
            </Pressable>
          )}
        </View>
      ))}

      <View style={styles.card}>
        <Text style={styles.name}>Active broker</Text>
        <Text style={styles.note} testID="switch-broker-note">
          Switching goes through the backend (`POST /v1/config/active-broker`), never a direct
          Firestore write — `config.activeBroker` is not client-writable. The target broker must
          already have a valid session for today; if it does not, the backend refuses and this
          screen offers to run its daily login first.
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
  makeActive: {
    marginTop: space.sm,
    minHeight: font.minTouchTarget,
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  makeActiveOn: { borderColor: colors.border, backgroundColor: colors.surface },
  makeActiveText: { color: colors.textMuted, fontSize: font.small, fontWeight: '700' },
  note: { color: colors.textMuted, fontSize: font.small, lineHeight: 19, marginTop: space.xs },
});
