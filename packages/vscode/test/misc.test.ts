import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEV_CHROME_EXTENSION_ID } from '@codealong/protocol';
import { createThrottle, isUserEdit } from '../src/activity';
import { ALLOWED_ORIGINS, readSettings } from '../src/settings';
import { loadOrCreateEditorToken } from '../src/hub/token';

describe('isUserEdit', () => {
  const doc = { uri: { scheme: 'file' } };
  const change = { document: doc, contentChanges: [{}] };

  it('counts edits in the focused, active editor', () => {
    expect(isUserEdit(change, { activeDocument: doc, windowFocused: true })).toBe(true);
  });

  it('ignores background changes, unfocused windows, empty changes and virtual documents', () => {
    expect(isUserEdit(change, { activeDocument: { uri: { scheme: 'file' } }, windowFocused: true })).toBe(false);
    expect(isUserEdit(change, { activeDocument: doc, windowFocused: false })).toBe(false);
    expect(isUserEdit({ document: doc, contentChanges: [] }, { activeDocument: doc, windowFocused: true })).toBe(false);
    for (const scheme of ['output', 'git', 'vscode-userdata', 'debug']) {
      const d = { uri: { scheme } };
      expect(isUserEdit({ document: d, contentChanges: [{}] }, { activeDocument: d, windowFocused: true })).toBe(false);
    }
  });
});

describe('createThrottle', () => {
  it('lets the first call through and thins out bursts', () => {
    let t = 0;
    const allow = createThrottle(200, () => t);
    expect(allow()).toBe(true);
    t = 100;
    expect(allow()).toBe(false);
    t = 200;
    expect(allow()).toBe(true);
  });
});

describe('readSettings', () => {
  const cfg = (values: Record<string, unknown>) => ({
    get: <T>(key: string, def: T): T => (key in values ? (values[key] as T) : def),
  });

  it('uses sensible defaults', () => {
    const s = readSettings(cfg({}));
    expect(s.core).toMatchObject({ enabled: true, pauseOnTyping: true, idleDelayMs: 5_000, rewindSeconds: 2 });
    expect(s.debugLogging).toBe(false);
  });

  it('clamps nonsense values and ignores wrong types', () => {
    const s = readSettings(
      cfg({ idleDelaySeconds: -3, rewindSeconds: 1e9, enabled: 'yes', resumeOnSave: null, debugLogging: 1 }),
    );
    expect(s.core.idleDelayMs).toBe(1_000);
    expect(s.core.rewindSeconds).toBe(60);
    expect(s.core.enabled).toBe(true);
    expect(s.core.resumeOnSave).toBe(true);
    expect(s.debugLogging).toBe(false);
    expect(readSettings(cfg({ idleDelaySeconds: 'ten' })).core.idleDelayMs).toBe(5_000);
  });

  it('only allows the known Chrome extension IDs to connect', () => {
    expect(ALLOWED_ORIGINS).toContain(`chrome-extension://${DEV_CHROME_EXTENSION_ID}`);
    for (const origin of ALLOWED_ORIGINS) expect(origin).toMatch(/^chrome-extension:\/\/[a-p]{32}$/);
  });
});

describe('loadOrCreateEditorToken', () => {
  it('creates a private token once and reuses it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codealong-token-'));
    try {
      const a = loadOrCreateEditorToken(dir);
      const b = loadOrCreateEditorToken(dir);
      expect(a).toMatch(/^[0-9a-f]{64}$/);
      expect(b).toBe(a);
      // POSIX permissions: readable by the current user only (Windows relies on the profile ACL).
      if (process.platform !== 'win32') expect(fs.statSync(path.join(dir, 'editor-token')).mode & 0o077).toBe(0);
      expect(fs.readdirSync(dir)).toEqual(['editor-token']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('replaces a corrupt token file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codealong-token-'));
    try {
      fs.writeFileSync(path.join(dir, 'editor-token'), 'garbage');
      expect(loadOrCreateEditorToken(dir)).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
