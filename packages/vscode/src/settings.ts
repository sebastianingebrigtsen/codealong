import { ALLOWED_CHROME_EXTENSION_IDS } from '@codealong/protocol';

/**
 * VS Code-side settings. Tutorial behaviour (timing, rewind, on/off) lives in the Chrome
 * extension, which owns those settings and sends them to VS Code; see docs/ARCHITECTURE.md.
 */
export interface ExtensionSettings {
  debugLogging: boolean;
}

/** Anything with a `get(key, default)` – vscode.WorkspaceConfiguration in practice. */
export interface ConfigLike {
  get<T>(key: string, defaultValue: T): T;
}

/** Origins allowed to connect as the browser. Not a setting: users never need to change this. */
export const ALLOWED_ORIGINS: readonly string[] = ALLOWED_CHROME_EXTENSION_IDS.map((id) => `chrome-extension://${id}`);

/**
 * Settings from 0.1.0 that now live in the Chrome popup. They are still declared (marked
 * deprecated) so existing values show an explanation instead of "unknown setting".
 */
export const LEGACY_SETTINGS = [
  'enabled',
  'pauseOnTyping',
  'resumeAfterIdle',
  'idleDelaySeconds',
  'resumeOnSave',
  'resumeOnTutorialFocus',
  'rewindBeforeResume',
  'rewindSeconds',
] as const;

export function readSettings(cfg: ConfigLike): ExtensionSettings {
  const debugLogging = cfg.get('debugLogging', false);
  return { debugLogging: typeof debugLogging === 'boolean' ? debugLogging : false };
}
