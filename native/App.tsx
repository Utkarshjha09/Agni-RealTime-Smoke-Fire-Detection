import {
  Inter_500Medium,
  Inter_600SemiBold,
} from "@expo-google-fonts/inter";
import {
  JetBrainsMono_500Medium,
  JetBrainsMono_600SemiBold,
} from "@expo-google-fonts/jetbrains-mono";
import { useFonts } from "expo-font";
import { StatusBar } from "expo-status-bar";
import { useState, type ComponentType } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { Glass } from "./components/Glass";
import { useLandscape } from "./components/useOrientation";
import { ArIcon, BellIcon, GaugeIcon, LayersIcon } from "./components/icons";
import ControlScreen from "./screens/ControlScreen";
import HistoryScreen from "./screens/HistoryScreen";
import MapScreen from "./screens/MapScreen";
import SettingsScreen from "./screens/SettingsScreen";
import { colors, font } from "./theme";
import type { AppTab } from "./domain/robot";
import { RobotProvider } from "./features/robot/RobotContext";

type ScreenProps = { landscape: boolean; onNavigate: (tab: AppTab) => void };

const tabs: { id: AppTab; label: string; Icon: typeof ArIcon; Screen: ComponentType<ScreenProps> }[] = [
  { id: "control", label: "Control", Icon: ArIcon, Screen: ControlScreen },
  { id: "map", label: "Map", Icon: LayersIcon, Screen: MapScreen },
  { id: "alerts", label: "Alerts", Icon: BellIcon, Screen: HistoryScreen },
  { id: "settings", label: "Settings", Icon: GaugeIcon, Screen: SettingsScreen },
] as const;

export default function App() {
  const [tab, setTab] = useState<AppTab>("control");
  const landscape = useLandscape();
  const [fontsLoaded, fontError] = useFonts({
    Inter_500Medium,
    Inter_600SemiBold,
    JetBrainsMono_500Medium,
    JetBrainsMono_600SemiBold,
  });

  const Active = tabs.find(t => t.id === tab)!.Screen;
  // Never leave a release build on a permanent blank boot screen if a bundled
  // font cannot be loaded; React Native will fall back to the system font.
  if (!fontsLoaded && !fontError) return <View style={styles.boot} />;

  return (
    <SafeAreaProvider>
      <RobotProvider>
        <StatusBar style="light" />
        <View style={styles.root}>
        <Active landscape={landscape} onNavigate={setTab} />

        {landscape ? (
          // Slim vertical rail on the left
          <SafeAreaView style={styles.railSafe} edges={["left", "top", "bottom"]} pointerEvents="box-none">
            <Glass radius={24} style={styles.rail}>
              {tabs.map(t => {
                const active = t.id === tab;
                return (
                  <Pressable key={t.id} onPress={() => setTab(t.id)} style={[styles.railBtn, active && styles.railBtnActive]}>
                    <t.Icon size={22} color={active ? colors.cyan : colors.inkMuted} />
                  </Pressable>
                );
              })}
            </Glass>
          </SafeAreaView>
        ) : (
          // Bottom tab bar
          <SafeAreaView style={styles.tabSafe} edges={["bottom"]} pointerEvents="box-none">
            <Glass radius={24} style={styles.tabBar}>
              {tabs.map(t => {
                const active = t.id === tab;
                return (
                  <Pressable key={t.id} onPress={() => setTab(t.id)} style={styles.tabBtn}>
                    <t.Icon size={22} color={active ? colors.cyan : colors.inkMuted} />
                    <Text style={[styles.tabLabel, { color: active ? colors.cyan : colors.inkMuted }]}>{t.label}</Text>
                  </Pressable>
                );
              })}
            </Glass>
          </SafeAreaView>
        )}
        </View>
      </RobotProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  boot: { flex: 1, backgroundColor: colors.bg0 },
  root: { flex: 1, backgroundColor: colors.bg0 },
  tabSafe: { position: "absolute", left: 0, right: 0, bottom: 0, paddingHorizontal: 16, paddingBottom: 8 },
  tabBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-around", paddingHorizontal: 8, paddingVertical: 8 },
  tabBtn: { flex: 1, alignItems: "center", gap: 4, paddingVertical: 6, borderRadius: 16 },
  tabLabel: { fontFamily: font.sans, fontSize: 10 },
  railSafe: { position: "absolute", left: 12, top: 0, bottom: 0, justifyContent: "center" },
  rail: { flexDirection: "column", alignItems: "center", gap: 4, padding: 8 },
  railBtn: { width: 44, height: 44, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  railBtnActive: { backgroundColor: "rgba(76,201,240,0.12)" },
});
