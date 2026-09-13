/**
 * Proposal inbox — docs/06 §6.3 (2).
 *
 * Tap opens the detail screen, which is the only place Approve exists. Reject
 * is inline and writes the one diff firestore.rules permits:
 * `{status:'rejected', decidedBy, decidedAt}` on a still-pending proposal.
 */
import { useCallback, useMemo, useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import type { Proposal } from '@pm/core';
import { useApp } from '../../../src/AppContext';
import { Banner } from '../../../src/components/Banner';
import { EmptyState } from '../../../src/components/GlobalBanners';
import { ProposalCard } from '../../../src/components/ProposalCard';
import { proposalRoute } from '../../../src/lib/deeplink';
import { rejectProposal, secondsUntil } from '../../../src/lib/proposals';
import { colors, font, space } from '../../../src/theme';

export default function ProposalsScreen() {
  const app = useApp();
  const router = useRouter();
  const [rejecting, setRejecting] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  /** Soonest to expire first — the ones that need you now are at the top. */
  const proposals = useMemo(
    () =>
      [...app.pendingProposals].sort((a, b) =>
        a.ttlExpiresAt < b.ttlExpiresAt ? -1 : a.ttlExpiresAt > b.ttlExpiresAt ? 1 : 0,
      ),
    [app.pendingProposals],
  );

  const onReject = useCallback(
    async (id: string) => {
      if (app.uid === undefined) return;
      setRejecting(id);
      setError(undefined);
      try {
        await rejectProposal(id, app.uid, new Date());
      } catch (caught) {
        setError(
          caught instanceof Error
            ? `Could not reject: ${caught.message}`
            : 'Could not reject this proposal.',
        );
      } finally {
        setRejecting(undefined);
      }
    },
    [app.uid],
  );

  const renderItem = useCallback(
    ({ item }: { item: Proposal }) => (
      <ProposalCard
        proposal={item}
        onOpen={(id) => router.push(proposalRoute(id))}
        onReject={(id) => void onReject(id)}
        rejecting={rejecting === item.id}
      />
    ),
    [router, onReject, rejecting],
  );

  const expiringSoon = proposals.filter((p) => secondsUntil(p.ttlExpiresAt, new Date()) > 0).length;

  return (
    <View style={styles.screen} testID="proposals-screen">
      <FlatList
        data={proposals}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          <View>
            {error === undefined ? null : (
              <Banner tone="danger" title="Reject failed" message={error} testID="reject-error" />
            )}
            {app.pendingError === undefined ? null : (
              <Banner
                tone="warn"
                title="Some proposals are hidden"
                message={app.pendingError}
                testID="proposals-error"
              />
            )}
            {proposals.length === 0 ? null : (
              <Text style={styles.count} testID="proposals-count">
                {expiringSoon} live · {proposals.length} pending
              </Text>
            )}
          </View>
        }
        ListEmptyComponent={
          <EmptyState
            title="Nothing waiting"
            message="New proposals arrive by push and appear here with a live countdown."
          />
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  list: { padding: space.md, paddingBottom: space.xxl },
  count: { color: colors.textMuted, fontSize: font.small, marginBottom: space.sm },
});
