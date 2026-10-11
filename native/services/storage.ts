/** Persists the rover connection so the URLs are not retyped on every launch.
 *
 * AsyncStorage is loaded lazily: if the package has not been installed yet
 * (`npx expo install @react-native-async-storage/async-storage`) the app still
 * runs, it simply forgets the rover between launches instead of crashing.
 */
import * as SecureStore from "expo-secure-store";
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

// The token lives in the phone's keystore (Android Keystore / iOS Keychain),
// encrypted at rest, rather than in AsyncStorage's plain file beside the URLs.
const TOKEN_KEY = "agni.token.v1";

async function readToken(): Promise<string> {
  try {
    return (await SecureStore.getItemAsync(TOKEN_KEY)) ?? "";
  } catch {
    return "";
  }
}

async function writeToken(token: string): Promise<void> {
  try {
    if (token) await SecureStore.setItemAsync(TOKEN_KEY, token);
    else await SecureStore.deleteItemAsync(TOKEN_KEY);
  } catch {
    // A keystore failure must never break a live driving session.
  }
}

export async function loadEndpoints(): Promise<Partial<RobotEndpoints> | null> {
  const stored = await readJson<RobotEndpoints>(ENDPOINTS_KEY);
  if (!stored) return null;
  let token = await readToken();
  if (typeof stored.token === "string" && stored.token) {
    // Saved by an older version in plain storage: move it to the keystore and
    // rewrite the plain copy without it.
    if (!token) {
      token = stored.token;
      await writeToken(token);
    }
    await writeJson(ENDPOINTS_KEY, { ...stored, token: "" });
  }
  return { ...stored, token };
}

export async function saveEndpoints(endpoints: RobotEndpoints): Promise<void> {
  await writeToken(endpoints.token);
  await writeJson(ENDPOINTS_KEY, { ...endpoints, token: "" });
}
export const loadSettings = () => readJson<RobotSettings>(SETTINGS_KEY);
export const saveSettings = (settings: RobotSettings) => writeJson(SETTINGS_KEY, settings);
