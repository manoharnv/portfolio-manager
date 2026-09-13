/**
 * Settings → Guardrails — docs/06 §6.3 (6).
 *
 * Edits `config.guardrails` only. The code ceilings from `@pm/core`
 * (`ABS_MAX_*`) are applied to the draft before it is written, and what they
 * pulled back is shown rather than silently swallowed: "never widen a limit to
 * make something pass" cuts both ways — the human should see the real cap.
 */
import { useCallback, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import type { GuardrailConfig } from '@pm/core';
import { useApp } from '../../../src/AppContext';
import { Banner } from '../../../src/components/Banner';
import { EmptyState } from '../../../src/components/GlobalBanners';
import { useUserPrefs, PREF_LABELS, type NotificationPrefs } from '../../../src/hooks/useUserPrefs';
import {
  ALL_PRODUCTS,
  ALL_SEGMENTS,
  CEILINGS,
  MAX_PRICE_COLLAR_PCT,
  ceilingWarnings,
  clampGuardrailDraft,
  formatSymbolList,
  parseNumberField,
  parseSymbolList,
  toggleMember,
} from '../../../src/lib/guardrailEdit';
import { inrWhole } from '../../../src/lib/format';
import { colors, font, radius, space } from '../../../src/theme';

export default function GuardrailsScreen() {
  const app = useApp();
  const prefs = useUserPrefs(app.uid);
  const [draft, setDraft] = useState<GuardrailConfig | undefined>(undefined);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const current = draft ?? app.config?.guardrails;
  const warnings = useMemo(
    () => (current === undefined ? [] : ceilingWarnings(current)),
    [current],
  );

  const patch = useCallback(
    (change: Partial<GuardrailConfig>) => {
      if (current === undefined) return;
      setSaved(false);
      setDraft({ ...current, ...change });
    },
    [current],
  );

  const save = useCallback(async () => {
    if (current === undefined) return;
    setError(undefined);
    const clamped = clampGuardrailDraft(current);
    try {
      await app.updateConfig({ guardrails: clamped }, new Date());
      setDraft(clamped);
      setSaved(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save the guardrails.');
    }
  }, [app, current]);

  if (current === undefined) {
    return (
      <EmptyState
        title="No config yet"
        message="The backend provisions config/{uid}; nothing has been written for this account."
      />
    );
  }

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      testID="guardrails-screen"
    >
      {error === undefined ? null : (
        <Banner tone="danger" title="Not saved" message={error} testID="guardrails-error" />
      )}
      {saved ? (
        <Banner
          tone="ok"
          title="Saved"
          message="The backend re-clamps these to the code ceilings on every order regardless."
          testID="guardrails-saved"
        />
      ) : null}
      {warnings.length === 0 ? null : (
        <Banner
          tone="warn"
          title="Above the code ceiling"
          message={warnings
            .map((w) => `${String(w.field)}: ${w.requested} will be saved as ${w.ceiling}`)
            .join('; ')}
          testID="ceiling-warning"
        />
      )}

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Limits</Text>
        <NumberField
          label="Max order value"
          hint={`ceiling ${inrWhole(CEILINGS.maxOrderValueInr)}`}
          value={current.maxOrderValueInr}
          testID="field-maxOrderValueInr"
          onChange={(v) => patch({ maxOrderValueInr: v })}
        />
        <NumberField
          label="Max daily notional"
          hint={`ceiling ${inrWhole(CEILINGS.maxDailyNotionalInr)}`}
          value={current.maxDailyNotionalInr}
          testID="field-maxDailyNotionalInr"
          onChange={(v) => patch({ maxDailyNotionalInr: v })}
        />
        <NumberField
          label="Max orders per day"
          hint={`ceiling ${CEILINGS.maxOrdersPerDay}`}
          value={current.maxOrdersPerDay}
          testID="field-maxOrdersPerDay"
          onChange={(v) => patch({ maxOrdersPerDay: v })}
        />
        <NumberField
          label="Price collar %"
          hint={`max ${MAX_PRICE_COLLAR_PCT}%`}
          value={current.priceCollarPct}
          testID="field-priceCollarPct"
          onChange={(v) => patch({ priceCollarPct: v })}
        />
        <NumberField
          label="Proposal TTL (seconds)"
          hint="how long you have to decide"
          value={current.proposalTtlSeconds}
          testID="field-proposalTtlSeconds"
          onChange={(v) => patch({ proposalTtlSeconds: v })}
        />
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Allowed segments</Text>
        <View style={styles.chips}>
          {ALL_SEGMENTS.map((segment) => (
            <Chip
              key={segment}
              label={segment}
              selected={current.allowedSegments.includes(segment)}
              testID={`segment-${segment}`}
              onPress={() =>
                patch({
                  allowedSegments: toggleMember(current.allowedSegments, ALL_SEGMENTS, segment),
                })
              }
            />
          ))}
        </View>

        <Text style={[styles.cardTitle, styles.spaced]}>Allowed products</Text>
        <View style={styles.chips}>
          {ALL_PRODUCTS.map((product) => (
            <Chip
              key={product}
              label={product}
              selected={current.allowedProducts.includes(product)}
              testID={`product-${product}`}
              onPress={() =>
                patch({
                  allowedProducts: toggleMember(current.allowedProducts, ALL_PRODUCTS, product),
                })
              }
            />
          ))}
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Symbols</Text>
        <TextField
          label="Allowlist (blank = no allowlist)"
          value={formatSymbolList(current.symbolAllowlist)}
          testID="field-symbolAllowlist"
          onChange={(text) => {
            const list = parseSymbolList(text);
            patch({ symbolAllowlist: list.length === 0 ? null : list });
          }}
        />
        <TextField
          label="Blocklist"
          value={formatSymbolList(current.symbolBlocklist)}
          testID="field-symbolBlocklist"
          onChange={(text) => patch({ symbolBlocklist: parseSymbolList(text) })}
        />
      </View>

      <View style={styles.card}>
        <View style={styles.switchRow}>
          <View style={styles.switchLabel}>
            <Text style={styles.label}>Require biometric to approve</Text>
            <Text style={styles.hint}>Off means a slide alone places an order. Leave it on.</Text>
          </View>
          <Switch
            accessibilityLabel="Require biometric"
            testID="field-requireBiometric"
            value={current.requireBiometric}
            onValueChange={(next) => patch({ requireBiometric: next })}
            trackColor={{ true: colors.ok, false: colors.disabled }}
          />
        </View>
      </View>

      <Pressable
        accessibilityRole="button"
        onPress={() => void save()}
        style={styles.save}
        testID="save-guardrails"
      >
        <Text style={styles.saveText}>Save guardrails</Text>
      </Pressable>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Notifications</Text>
        {(Object.keys(PREF_LABELS) as (keyof NotificationPrefs)[]).map((key) => (
          <View key={key} style={styles.switchRow}>
            <Text style={styles.label}>{PREF_LABELS[key]}</Text>
            <Switch
              accessibilityLabel={PREF_LABELS[key]}
              testID={`pref-${key}`}
              value={prefs.prefs[key]}
              onValueChange={(next) => void prefs.setPref(key, next)}
              trackColor={{ true: colors.ok, false: colors.disabled }}
            />
          </View>
        ))}
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Strategies</Text>
        <Text style={styles.hint}>
          Per-strategy on/off and parameters live in `strategies/{'{uid}'}/defs`, which
          firestore.rules makes read-only for the client and which `@pm/core` does not model yet.
          Use the strategy-engine config until a backend route exists. The master switch is Settings
          → Trading.
        </Text>
      </View>
    </ScrollView>
  );
}

function NumberField(props: {
  label: string;
  hint: string;
  value: number;
  testID: string;
  onChange: (value: number) => void;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{props.label}</Text>
      <TextInput
        accessibilityLabel={props.label}
        testID={props.testID}
        keyboardType="numeric"
        defaultValue={String(props.value)}
        onChangeText={(text) => props.onChange(parseNumberField(text, props.value))}
        style={styles.input}
        placeholderTextColor={colors.textMuted}
      />
      <Text style={styles.hint}>{props.hint}</Text>
    </View>
  );
}

function TextField(props: {
  label: string;
  value: string;
  testID: string;
  onChange: (text: string) => void;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{props.label}</Text>
      <TextInput
        accessibilityLabel={props.label}
        testID={props.testID}
        autoCapitalize="characters"
        defaultValue={props.value}
        onChangeText={props.onChange}
        style={styles.input}
        placeholder="INFY, TCS"
        placeholderTextColor={colors.textMuted}
      />
    </View>
  );
}

function Chip(props: { label: string; selected: boolean; testID: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: props.selected }}
      accessibilityLabel={props.label}
      testID={props.testID}
      onPress={props.onPress}
      style={[styles.chip, props.selected ? styles.chipOn : styles.chipOff]}
    >
      <Text style={[styles.chipText, props.selected ? styles.chipTextOn : styles.chipTextOff]}>
        {props.label}
      </Text>
    </Pressable>
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
  spaced: { marginTop: space.lg },
  field: { marginBottom: space.md },
  label: { color: colors.text, fontSize: font.small, fontWeight: '600' },
  hint: { color: colors.textMuted, fontSize: font.small, marginTop: space.xs, lineHeight: 18 },
  input: {
    marginTop: space.xs,
    minHeight: font.minTouchTarget,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    color: colors.text,
    fontSize: font.body,
    backgroundColor: colors.surfaceAlt,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: {
    minHeight: font.minTouchTarget,
    paddingHorizontal: space.md,
    justifyContent: 'center',
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  chipOn: { borderColor: colors.accent, backgroundColor: colors.surfaceAlt },
  chipOff: { borderColor: colors.border, backgroundColor: colors.surface },
  chipText: { fontSize: font.small, fontWeight: '700' },
  chipTextOn: { color: colors.accent },
  chipTextOff: { color: colors.textMuted },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.xs,
  },
  switchLabel: { flex: 1 },
  save: {
    minHeight: 56,
    borderRadius: radius.md,
    borderWidth: 2,
    borderColor: colors.accent,
    backgroundColor: colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: space.md,
  },
  saveText: { color: colors.accent, fontSize: font.body, fontWeight: '800' },
});
