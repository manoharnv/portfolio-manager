/**
 * The always-on status strip (docs/06 §6.6). Anything that would stop an
 * approval is stated here, on every screen, before the human taps anything.
 */
import { StyleSheet, Text, View } from 'react-native';
import { useApp } from '../AppContext';
import { Banner } from './Banner';
import { colors, font, space } from '../theme';

export function GlobalBanners() {
  const { config, backendReachable, session, sessionError, configError, uid } = useApp();
  if (uid === undefined) return null;

  const activeBroker = session?.activeBroker ?? null;
  const active = session?.brokers.find((b) => b.broker === activeBroker);
  const needsLogin =
    session !== undefined && (activeBroker === null || active?.needsLogin === true);

  return (
    <View style={styles.banners}>
      {configError === undefined ? null : (
        <Banner
          tone="danger"
          title="Configuration problem"
          message={configError}
          testID="banner-config"
        />
      )}
      {config?.killSwitch === true ? (
        <Banner
          tone="danger"
          title="Kill switch on — trading halted"
          message="Every order is refused until you turn it off on the dashboard."
          testID="banner-killswitch"
        />
      ) : null}
      {config !== undefined && !config.tradingEnabled ? (
        <Banner
          tone="warn"
          title="Trading disabled"
          message="The strategy engine is off; existing proposals cannot be executed."
          testID="banner-trading-disabled"
        />
      ) : null}
      {backendReachable ? null : (
        <Banner
          tone="danger"
          title="Execution unavailable"
          message={
            sessionError ?? 'The execution backend is not answering. Approvals are disabled.'
          }
          testID="banner-backend-down"
        />
      )}
      {backendReachable && needsLogin ? (
        <Banner
          tone="warn"
          title="Broker session needed"
          message={active?.reason ?? 'No active broker session for today.'}
          testID="banner-no-session"
        />
      ) : null}
    </View>
  );
}

/** Shown while a screen has nothing yet — never a blank rectangle. */
export function Loading({ label }: { label: string }) {
  return (
    <View style={styles.loading} accessibilityRole="progressbar">
      <Text style={styles.loadingText}>{label}</Text>
    </View>
  );
}

/** An empty list is a state worth naming, not an absence. */
export function EmptyState({ title, message }: { title: string; message?: string | undefined }) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>{title}</Text>
      {message === undefined ? null : <Text style={styles.emptyMessage}>{message}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  banners: { paddingHorizontal: space.md, paddingTop: space.sm },
  loading: { padding: space.xl, alignItems: 'center' },
  loadingText: { color: colors.textMuted, fontSize: font.body },
  empty: { padding: space.xl, alignItems: 'center' },
  emptyTitle: { color: colors.text, fontSize: font.body, fontWeight: '700' },
  emptyMessage: {
    color: colors.textMuted,
    fontSize: font.small,
    marginTop: space.xs,
    textAlign: 'center',
  },
});
