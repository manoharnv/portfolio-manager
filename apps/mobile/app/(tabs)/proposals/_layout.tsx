import { Stack } from 'expo-router';
import { colors } from '../../../src/theme';

export default function ProposalsLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.bg },
        headerTintColor: colors.text,
        headerTitleStyle: { fontWeight: '700' },
        contentStyle: { backgroundColor: colors.bg },
      }}
    >
      <Stack.Screen name="index" options={{ title: 'Proposals' }} />
      <Stack.Screen name="[id]" options={{ title: 'Review' }} />
    </Stack>
  );
}
