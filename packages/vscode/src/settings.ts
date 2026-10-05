import { CHROME_EXTENSION_ID, DEFAULT_PORT } from '@codealong/protocol';
import { DEFAULT_SETTINGS, type CoreSettings } from './core/hubCore';

export interface ExtensionSettings {
  core: CoreSettings;
  debug: boolean;
  port: number;
  allowedOrigins: string[];
}

/** Anything with a `get(key, default)` – vscode.WorkspaceConfiguration in practice. */
export interface ConfigLike {
  get<T>(key: string, defaultValue: T): T;
}

function clamp(n: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

export function readSettings(cfg: ConfigLike): ExtensionSettings {
  const d = DEFAULT_SETTINGS;
  const ids = cfg.get<string[]>('allowedChromeExtensionIds', [CHROME_EXTENSION_ID]);
  return {
    core: {
      enabled: cfg.get('enabled', d.enabled),
      pauseOnTyping: cfg.get('pauseOnTyping', d.pauseOnTyping),
      resumeOnIdle: cfg.get('resumeAfterIdle', d.resumeOnIdle),
      idleDelayMs: clamp(cfg.get('idleDelaySeconds', d.idleDelayMs / 1000), 1, 600, 5) * 1000,
      resumeOnSave: cfg.get('resumeOnSave', d.resumeOnSave),
      resumeOnFocus: cfg.get('resumeOnTutorialFocus', d.resumeOnFocus),
      rewindBeforeResume: cfg.get('rewindBeforeResume', d.rewindBeforeResume),
      rewindSeconds: clamp(cfg.get('rewindSeconds', d.rewindSeconds), 0, 60, 2),
    },
    debug: cfg.get('debug', false),
    port: Math.round(clamp(cfg.get('port', DEFAULT_PORT), 1024, 65535, DEFAULT_PORT)),
    allowedOrigins: (Array.isArray(ids) ? ids : [])
      .filter((id) => typeof id === 'string' && /^[a-p]{32}$/.test(id))
      .map((id) => `chrome-extension://${id}`),
  };
}
