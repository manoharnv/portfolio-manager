/**
 * The guardrail checklist (docs/06 §6.3 (3)): every check with ✓/✗ and its
 * detail. All checks always render — `runGuardrails` never short-circuits
 * precisely so the human can see every reason at once.
 */
import { StyleSheet, Text, View } from 'react-native';
import type { GuardrailCheck } from '@pm/core';
import { colors, font, radius, space } from '../theme';

export interface GuardrailChecklistProps {
  checks: readonly GuardrailCheck[];
  /** Extra checks the *client* computed (TTL, backend reachability, collar). */
  extra?: readonly GuardrailCheck[] | undefined;
  title?: string | undefined;
  testID?: string | undefined;
}

export function GuardrailChecklist(props: GuardrailChecklistProps) {
  const rows = [...props.checks, ...(props.extra ?? [])];
  const failed = rows.filter((c) => !c.ok).length;

  return (
    <View style={styles.container} testID={props.testID}>
      <View style={styles.header}>
        <Text style={styles.title}>{props.title ?? 'Guardrails'}</Text>
        <Text style={[styles.summary, failed > 0 ? styles.summaryBad : styles.summaryGood]}>
          {failed === 0 ? `${rows.length} passed` : `${failed} failed`}
        </Text>
      </View>
      {rows.length === 0 ? (
        <Text style={styles.empty}>No guardrail results on this proposal.</Text>
      ) : (
        rows.map((check) => (
          <View key={check.name} style={styles.row} testID={`guardrail-${check.name}`}>
            <Text
              style={[styles.mark, check.ok ? styles.markOk : styles.markBad]}
              accessibilityLabel={check.ok ? 'passed' : 'failed'}
            >
              {check.ok ? '✓' : '✗'}
            </Text>
            <View style={styles.body}>
              <Text style={styles.name}>{check.name}</Text>
              <Text style={styles.detail}>{check.detail}</Text>
            </View>
          </View>
        ))
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: space.md,
    marginBottom: space.md,
  },
  header: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: space.sm },
  title: { color: colors.text, fontSize: font.body, fontWeight: '700' },
  summary: { fontSize: font.small, fontWeight: '700' },
  summaryGood: { color: colors.ok },
  summaryBad: { color: colors.danger },
  empty: { color: colors.textMuted, fontSize: font.small },
  row: { flexDirection: 'row', paddingVertical: space.xs, alignItems: 'flex-start' },
  mark: { width: 22, fontSize: font.body, fontWeight: '700' },
  markOk: { color: colors.ok },
  markBad: { color: colors.danger },
  body: { flex: 1 },
  name: { color: colors.text, fontSize: font.small, fontWeight: '700' },
  detail: { color: colors.textMuted, fontSize: font.small, lineHeight: 17 },
});
