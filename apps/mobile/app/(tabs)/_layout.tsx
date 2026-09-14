/**
 * The five tabs of docs/06 §6.3. Settings and Audit share the last slot's
 * neighbourhood; Proposals carries the pending badge because it is the only
 * tab that is ever *urgent*.
 */
import { Tabs } from 'expo-router';
import { Text, type ColorValue } from 'react-native';
import { useApp } from '../../src/AppContext';
import { colors, font } from '../../src/theme';

/** Exported for the layout test; expo-router only consumes the default export. */
export function TabIcon({ glyph, color }: { glyph: string; color: ColorValue }) {
  return <Text style={{ color, fontSize: 18 }}>{glyph}</Text>;
}

export default function TabsLayout() {
  const { pendingProposals } = useApp();
  const pending = pendingProposals.length;

  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: colors.bg },
        headerTintColor: colors.text,
        headerTitleStyle: { fontWeight: '700' },
        tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border },
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarLabelStyle: { fontSize: font.small },
        sceneStyle: { backgroundColor: colors.bg },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Dashboard',
          tabBarIcon: ({ color }) => <TabIcon glyph="◧" color={color} />,
        }}
      />
      <Tabs.Screen
        name="proposals"
        options={{
          title: 'Proposals',
          headerShown: false,
          // `exactOptionalPropertyTypes` — the key must be absent, not undefined.
          ...(pending > 0 ? { tabBarBadge: pending } : {}),
          tabBarIcon: ({ color }) => <TabIcon glyph="◎" color={color} />,
        }}
      />
      <Tabs.Screen
        name="orders"
        options={{
          title: 'Orders',
          headerShown: false,
          tabBarIcon: ({ color }) => <TabIcon glyph="≡" color={color} />,
        }}
      />
      <Tabs.Screen
        name="broker"
        options={{
          title: 'Broker',
          tabBarIcon: ({ color }) => <TabIcon glyph="⇄" color={color} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          headerShown: false,
          tabBarIcon: ({ color }) => <TabIcon glyph="⚙" color={color} />,
        }}
      />
      <Tabs.Screen
        name="audit"
        options={{
          title: 'Audit',
          tabBarIcon: ({ color }) => <TabIcon glyph="🗒" color={color} />,
        }}
      />
    </Tabs>
  );
}
