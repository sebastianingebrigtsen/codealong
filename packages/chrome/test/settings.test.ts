import { describe, expect, it } from 'vitest';
import { DEFAULT_SHARED_SETTINGS } from '@codealong/protocol';
import {
  DEFAULT_CHROME_SETTINGS,
  LEGACY_STORAGE_KEY,
  STORAGE_KEY,
  applySettingsPatch,
  readStoredSettings,
} from '../src/shared/settings';

describe('stored settings', () => {
  it('starts with defaults on a fresh install', () => {
    expect(readStoredSettings({})).toEqual(DEFAULT_CHROME_SETTINGS);
  });

  it('migrates the 0.1.0 format (only on/off and debug existed)', () => {
    expect(readStoredSettings({ [LEGACY_STORAGE_KEY]: { enabled: false, debug: true, port: 47390 } })).toEqual({
      shared: { ...DEFAULT_SHARED_SETTINGS, enabled: false },
      showOverlay: true,
      debug: true,
    });
  });

  it('repairs damaged or partial data instead of failing', () => {
    const s = readStoredSettings({
      [STORAGE_KEY]: { shared: { idleDelaySeconds: 500, rewindSeconds: 'x' }, showOverlay: 'no' },
    });
    expect(s.shared.idleDelaySeconds).toBe(30);
    expect(s.shared.rewindSeconds).toBe(DEFAULT_SHARED_SETTINGS.rewindSeconds);
    expect(s.showOverlay).toBe(true);
    expect(readStoredSettings({ [STORAGE_KEY]: 'corrupt' })).toEqual(DEFAULT_CHROME_SETTINGS);
  });

  it('returns a fresh copy, never the shared defaults object', () => {
    const a = readStoredSettings({});
    a.shared.idleDelaySeconds = 20;
    expect(DEFAULT_CHROME_SETTINGS.shared.idleDelaySeconds).toBe(5);
  });
});

describe('applySettingsPatch', () => {
  it('changes only what the patch names, validated', () => {
    const next = applySettingsPatch(DEFAULT_CHROME_SETTINGS, { idleDelaySeconds: 12, showOverlay: false });
    expect(next.shared).toEqual({ ...DEFAULT_SHARED_SETTINGS, idleDelaySeconds: 12 });
    expect(next.showOverlay).toBe(false);
    expect(next.debug).toBe(false);
  });

  it('rejects wrong types and clamps numbers', () => {
    const next = applySettingsPatch(DEFAULT_CHROME_SETTINGS, { enabled: 'off', rewindSeconds: 99, debug: 1 });
    expect(next.shared.enabled).toBe(true);
    expect(next.shared.rewindSeconds).toBe(15);
    expect(next.debug).toBe(false);
    expect(applySettingsPatch(DEFAULT_CHROME_SETTINGS, null)).toBe(DEFAULT_CHROME_SETTINGS);
  });
});

describe('diagnostics', () => {
  it('never contains URLs or host names', async () => {
    const { scrub } = await import('../src/shared/diagnostics');
    expect(scrub('10:15:02 TUTORIAL_ACTIVATED www.youtube.com')).toBe('10:15:02 TUTORIAL_ACTIVATED <host>');
    expect(scrub('INJECT_FAILED Cannot access contents of url "https://udemy.com/course/x?y=1".')).not.toMatch(
      /udemy|course/,
    );
    expect(scrub('10:15:03 VIDEO_MANUAL_PAUSE')).toBe('10:15:03 VIDEO_MANUAL_PAUSE');
  });
});
