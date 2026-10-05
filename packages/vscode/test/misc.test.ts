import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROME_EXTENSION_ID, DEFAULT_PORT } from '@codealong/protocol';
import { createThrottle, isUserEdit } from '../src/activity';
import { readSettings } from '../src/settings';
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
    expect(s.port).toBe(DEFAULT_PORT);
    expect(s.allowedOrigins).toEqual([`chrome-extension://${CHROME_EXTENSION_ID}`]);
  });

  it('clamps nonsense values and drops invalid extension ids', () => {
    const s = readSettings(
      cfg({ idleDelaySeconds: -3, rewindSeconds: 1e9, port: 80, allowedChromeExtensionIds: ['bad', '*', 'a'.repeat(32)] }),
    );
    expect(s.core.idleDelayMs).toBe(1_000);
    expect(s.core.rewindSeconds).toBe(60);
    expect(s.port).toBe(1024);
    expect(s.allowedOrigins).toEqual([`chrome-extension://${'a'.repeat(32)}`]);
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
      expect(fs.statSync(path.join(dir, 'editor-token')).mode & 0o077).toBe(0);
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
