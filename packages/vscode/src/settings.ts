import { ALLOWED_CHROME_EXTENSION_IDS } from '@codealong/protocol';
import { DEFAULT_SETTINGS, type CoreSettings } from './core/hubCore';

export interface ExtensionSettings {
  core: CoreSettings;
  debugLogging: boolean;
}

/** Anything with a `get(key, default)` – vscode.WorkspaceConfiguration in practice. */
export interface ConfigLike {
  get<T>(key: string, defaultValue: T): T;
}

/** Origins allowed to connect as the browser. Not a setting: users never need to change this. */
export const ALLOWED_ORIGINS: readonly string[] = ALLOWED_CHROME_EXTENSION_IDS.map((id) => `chrome-extension://${id}`);

function clamp(n: unknown, min: number, max: number, fallback: number): number {
  return typeof n === 'number' && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

/** Reads the `codealong.*` settings, falling back to safe defaults for invalid values. */
export function readSettings(cfg: ConfigLike): ExtensionSettings {
  const d = DEFAULT_SETTINGS;
  return {
    core: {
      enabled: bool(cfg.get('enabled', d.enabled), d.enabled),
      pauseOnTyping: bool(cfg.get('pauseOnTyping', d.pauseOnTyping), d.pauseOnTyping),
      resumeOnIdle: bool(cfg.get('resumeAfterIdle', d.resumeOnIdle), d.resumeOnIdle),
      idleDelayMs: clamp(cfg.get('idleDelaySeconds', d.idleDelayMs / 1000), 1, 600, d.idleDelayMs / 1000) * 1000,
      resumeOnSave: bool(cfg.get('resumeOnSave', d.resumeOnSave), d.resumeOnSave),
      resumeOnFocus: bool(cfg.get('resumeOnTutorialFocus', d.resumeOnFocus), d.resumeOnFocus),
      rewindBeforeResume: bool(cfg.get('rewindBeforeResume', d.rewindBeforeResume), d.rewindBeforeResume),
      rewindSeconds: clamp(cfg.get('rewindSeconds', d.rewindSeconds), 0, 60, d.rewindSeconds),
    },
    debugLogging: bool(cfg.get('debugLogging', false), false),
  };
}
