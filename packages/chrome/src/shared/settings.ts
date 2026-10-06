import { DEFAULT_SHARED_SETTINGS, sanitizeSettings, type SharedSettings } from '@codealong/protocol';

/**
 * Everything the Chrome extension stores about the user's preferences (chrome.storage.local:
 * persistent, never synced to the cloud).
 *  - `shared`: tutorial behaviour; sent to VS Code, which applies it.
 *  - the rest only affects Chrome.
 */
export interface ChromeSettings {
  shared: SharedSettings;
  /** Small "Paused while you code" label on the video. */
  showOverlay: boolean;
  /** Event log in the popup and console logging. */
  debug: boolean;
}

export const DEFAULT_CHROME_SETTINGS: ChromeSettings = {
  shared: { ...DEFAULT_SHARED_SETTINGS },
  showOverlay: true,
  debug: false,
};

export const STORAGE_KEY = 'preferences';
/** 0.1.0 stored `{ enabled, debug }` under this key. */
export const LEGACY_STORAGE_KEY = 'settings';

/** Builds valid settings from whatever is in storage, migrating the 0.1.0 format. */
export function readStoredSettings(stored: Record<string, unknown>): ChromeSettings {
  const current = stored[STORAGE_KEY];
  if (isObject(current)) {
    return {
      shared: sanitizeSettings(current.shared),
      showOverlay: typeof current.showOverlay === 'boolean' ? current.showOverlay : DEFAULT_CHROME_SETTINGS.showOverlay,
      debug: typeof current.debug === 'boolean' ? current.debug : DEFAULT_CHROME_SETTINGS.debug,
    };
  }
  const legacy = stored[LEGACY_STORAGE_KEY];
  if (isObject(legacy)) {
    return {
      shared: sanitizeSettings({ enabled: legacy.enabled }),
      showOverlay: DEFAULT_CHROME_SETTINGS.showOverlay,
      debug: typeof legacy.debug === 'boolean' ? legacy.debug : false,
    };
  }
  return structuredClone(DEFAULT_CHROME_SETTINGS);
}

/** What the popup may change. Unknown keys and wrong types are dropped. */
export interface SettingsPatch extends Partial<SharedSettings> {
  showOverlay?: boolean;
  debug?: boolean;
}

export function applySettingsPatch(current: ChromeSettings, patch: unknown): ChromeSettings {
  if (!isObject(patch)) return current;
  return {
    shared: sanitizeSettings(patch, current.shared),
    showOverlay: typeof patch.showOverlay === 'boolean' ? patch.showOverlay : current.showOverlay,
    debug: typeof patch.debug === 'boolean' ? patch.debug : current.debug,
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
