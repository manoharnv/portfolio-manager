/**
 * Audit — docs/06 §6.3 (7). Read-only by construction: `auditLog` is
 * append-only and client-unwritable (firestore.rules, docs/07 §7.7), which is
 * what makes this feed worth trusting.
 */
import { useCallback } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import type { AuditEvent } from '@pm/core';
import { useApp } from '../../src/AppContext';
import { Banner } from '../../src/components/Banner';
import { EmptyState, Loading } from '../../src/components/GlobalBanners';
import { auditLabel, isAlert, useAuditLog } from '../../src/hooks/useAuditLog';
import { istDateTime } from '../../src/lib/format';
import { colors, font, radius, space } from '../../src/theme';

/** One line of `detail`, without dumping a whole object at the human. */
export function summariseDetail(detail: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(detail)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'object') continue;
    parts.push(`${key}: ${String(value)}`);
    if (parts.length === 3) break;
  }
  return parts.join(' · ');
}

export default function AuditScreen() {
  const { uid } = useApp();
  const audit = useAuditLog(uid);

  const renderItem = useCallback(({ item }: { item: AuditEvent }) => {
    const alert = isAlert(item);
    return (
      <View style={styles.row} testID={`audit-${item.id}`}>
        <View style={styles.rowTop}>
          <Text style={[styles.type, alert ? styles.typeAlert : styles.typeNormal]}>
            {auditLabel(item.type)}
          </Text>
          <View style={styles.spacer} />
          <Text style={styles.ts}>{istDateTime(item.ts)}</Text>
        </View>
        <Text style={styles.actor}>
          {item.actor}
          {item.refId === undefined ? '' : ` · ${item.refId}`}
          {item.ip === undefined ? '' : ` · ${item.ip}`}
        </Text>
        {Object.keys(item.detail).length === 0 ? null : (
          <Text style={styles.detail} numberOfLines={3}>
            {summariseDetail(item.detail)}
          </Text>
        )}
      </View>
    );
  }, []);

  if (audit.loading) return <Loading label="Loading audit log…" />;

  return (
    <View style={styles.screen} testID="audit-screen">
      <FlatList
        data={audit.data}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          audit.error === undefined ? null : (
            <Banner tone="warn" title="Some events are hidden" message={audit.error} />
          )
        }
        ListEmptyComponent={
          <EmptyState
            title="No audit events"
            message="Proposals, approvals, orders, blocks, logins and IP changes land here."
          />
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  list: { padding: space.md, paddingBottom: space.xxl },
  row: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: space.md,
    marginBottom: space.sm,
  },
  rowTop: { flexDirection: 'row', alignItems: 'center' },
  type: { fontSize: font.small, fontWeight: '700' },
  typeAlert: { color: colors.warn },
  typeNormal: { color: colors.text },
  spacer: { flex: 1 },
  ts: { color: colors.textMuted, fontSize: font.small },
  actor: { color: colors.textMuted, fontSize: font.small, marginTop: space.xs },
  detail: { color: colors.textMuted, fontSize: font.small, marginTop: space.xs },
});
