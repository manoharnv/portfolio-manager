import { Stack } from 'expo-router';
import { colors } from '../../../src/theme';

export default function OrdersLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.bg },
        headerTintColor: colors.text,
        headerTitleStyle: { fontWeight: '700' },
        contentStyle: { backgroundColor: colors.bg },
      }}
    >
      <Stack.Screen name="index" options={{ title: 'Orders' }} />
      <Stack.Screen name="[id]" options={{ title: 'Order' }} />
    </Stack>
  );
}
