/** Persists the rover connection so the URLs are not retyped on every launch.
 *
 * AsyncStorage is loaded lazily: if the package has not been installed yet
 * (`npx expo install @react-native-async-storage/async-storage`) the app still
 * runs, it simply forgets the rover between launches instead of crashing.
 */
import type { RobotEndpoints, RobotSettings } from "../domain/robot";

type AsyncStorageLike = {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
};

const ENDPOINTS_KEY = "agni.endpoints.v1";
const SETTINGS_KEY = "agni.settings.v1";

let store: AsyncStorageLike | null | undefined;
let warned = false;

function getStore(): AsyncStorageLike | null {
  if (store !== undefined) return store;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    store = require("@react-native-async-storage/async-storage").default as AsyncStorageLike;
  } catch {
    store = null;
    if (!warned) {
      warned = true;
      console.warn(
        "@react-native-async-storage/async-storage is not installed; rover settings will not persist. " +
          "Run: npx expo install @react-native-async-storage/async-storage",
      );
    }
  }
  return store;
}

async function readJson<T>(key: string): Promise<Partial<T> | null> {
  const storage = getStore();
  if (!storage) return null;
  try {
    const raw = await storage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Partial<T>) : null;
  } catch {
    return null;
  }
}

async function writeJson(key: string, value: unknown): Promise<void> {
  const storage = getStore();
  if (!storage) return;
  try {
    await storage.setItem(key, JSON.stringify(value));
  } catch {
    // Losing a preference must never break a live driving session.
  }
}

export const loadEndpoints = () => readJson<RobotEndpoints>(ENDPOINTS_KEY);
export const saveEndpoints = (endpoints: RobotEndpoints) => writeJson(ENDPOINTS_KEY, endpoints);
export const loadSettings = () => readJson<RobotSettings>(SETTINGS_KEY);
export const saveSettings = (settings: RobotSettings) => writeJson(SETTINGS_KEY, settings);
