import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SHARED_SETTINGS,
  describeSettings,
  describeStatus,
  parseBrowserMessage,
  parseEditorMessage,
  parseHubMessage,
  parseSettingsPatch,
  sanitizeSettings,
  type HubStatus,
} from '../src/index';

describe('parseBrowserMessage', () => {
  it('accepts well-formed messages', () => {
    const video = { status: 'paused', owner: 'codealong', pauseId: 'x-1', currentTime: 12.5, duration: null };
    expect(parseBrowserMessage(JSON.stringify({ type: 'video', video, cause: 'codealong-pause' }))).toEqual({
      type: 'video',
      video,
      cause: 'codealong-pause',
    });
    expect(parseBrowserMessage('{"type":"tutorial","tutorial":null}')).toEqual({ type: 'tutorial', tutorial: null });
  });

  it('normalises owner/pauseId so they can only exist on a paused video', () => {
    const video = { status: 'playing', owner: 'codealong', pauseId: 'x-1', currentTime: 1, duration: 10 };
    const msg = parseBrowserMessage(JSON.stringify({ type: 'video', video, cause: 'sync' }));
    expect(msg).toMatchObject({ video: { owner: null, pauseId: null } });
  });

  it('rejects garbage', () => {
    for (const raw of [
      'nope',
      '[]',
      '{"type":"video"}',
      '{"type":"video","video":{"status":"paused","owner":"hacker","pauseId":null,"currentTime":1,"duration":1},"cause":"sync"}',
      '{"type":"video","video":{"status":"playing","owner":null,"pauseId":null,"currentTime":-5,"duration":1},"cause":"sync"}',
      '{"type":"control","action":"rm -rf"}',
      '{"type":"activity","kind":"edit"}', // editor-only message
      'x'.repeat(20_000),
    ]) {
      expect(parseBrowserMessage(raw)).toBeNull();
    }
  });
});

describe('parseEditorMessage / parseHubMessage', () => {
  it('parses editor activity and hub commands', () => {
    expect(parseEditorMessage('{"type":"activity","kind":"save"}')).toEqual({ type: 'activity', kind: 'save' });
    expect(parseHubMessage('{"type":"command","id":3,"command":"resume","pauseId":"a","rewindSeconds":2}')).toEqual({
      type: 'command',
      id: 3,
      command: 'resume',
      pauseId: 'a',
      rewindSeconds: 2,
    });
    expect(parseHubMessage('{"type":"command","id":3,"command":"resume","pauseId":"a","rewindSeconds":-1}')).toBeNull();
    expect(parseHubMessage('{"type":"command","id":3,"command":"selfDestruct"}')).toBeNull();
  });
});

describe('describeStatus', () => {
  const base: HubStatus = {
    phase: 'coding',
    enabled: true,
    browserConnected: true,
    tutorialTitle: null,
    resumeAt: null,
    settings: null,
  };
  it('shows a countdown only when a resume is close', () => {
    expect(describeStatus(base, 0)).toBe('Coding...');
    expect(describeStatus({ ...base, resumeAt: 10_000 }, 0)).toBe('Coding...');
    expect(describeStatus({ ...base, resumeAt: 2_100 }, 0)).toBe('Coding... (resume in 3s)');
  });
});

describe('settings', () => {
  it('fills in defaults and clamps out-of-range or wrongly typed values', () => {
    expect(sanitizeSettings(undefined)).toEqual(DEFAULT_SHARED_SETTINGS);
    expect(sanitizeSettings('garbage')).toEqual(DEFAULT_SHARED_SETTINGS);
    expect(
      sanitizeSettings({ idleDelaySeconds: 999, rewindSeconds: -4, resumeOnSave: 'yes', enabled: false, extra: 1 }),
    ).toEqual({ ...DEFAULT_SHARED_SETTINGS, idleDelaySeconds: 30, rewindSeconds: 1, enabled: false });
    expect(sanitizeSettings({ idleDelaySeconds: 7.6, rewindSeconds: Number.NaN }).idleDelaySeconds).toBe(8);
    expect(sanitizeSettings({ rewindSeconds: Infinity }).rewindSeconds).toBe(DEFAULT_SHARED_SETTINGS.rewindSeconds);
  });

  it('merges a partial update onto the current settings', () => {
    const current = { ...DEFAULT_SHARED_SETTINGS, idleDelaySeconds: 12 };
    expect(sanitizeSettings({ rewindSeconds: 4 }, current)).toEqual({ ...current, rewindSeconds: 4 });
  });

  it('only accepts known, correctly typed keys in a patch', () => {
    expect(parseSettingsPatch({ enabled: false, idleDelaySeconds: '5', __proto__: 1, nope: true })).toEqual({
      enabled: false,
    });
    expect(parseSettingsPatch({ idleDelaySeconds: 100 })).toEqual({ idleDelaySeconds: 30 });
    expect(parseSettingsPatch({})).toBeNull();
    expect(parseSettingsPatch(null)).toBeNull();
  });

  it('describes the settings in plain words', () => {
    expect(describeSettings(DEFAULT_SHARED_SETTINGS)).toBe(
      'Continues 5\u00a0s after you stop typing or when you save · rewinds 2\u00a0s',
    );
    expect(
      describeSettings({
        ...DEFAULT_SHARED_SETTINGS,
        resumeOnIdle: false,
        resumeOnSave: false,
        rewindBeforeResume: false,
      }),
    ).toBe('Continues only when you say so');
    expect(describeSettings({ ...DEFAULT_SHARED_SETTINGS, enabled: false })).toBe('Automatic pausing is off');
  });

  it('parses the new messages and stays compatible with 0.1.0 peers', () => {
    expect(parseBrowserMessage(JSON.stringify({ type: 'settings', settings: { idleDelaySeconds: 3 } }))).toEqual({
      type: 'settings',
      settings: { ...DEFAULT_SHARED_SETTINGS, idleDelaySeconds: 3 },
    });
    expect(parseHubMessage('{"type":"welcome","protocol":1,"hub":"vscode"}')).toEqual({
      type: 'welcome',
      protocol: 1,
      hub: 'vscode',
    });
    expect(
      parseHubMessage('{"type":"welcome","protocol":1,"hub":"vscode","version":"0.2.0","features":["settings","x"]}'),
    ).toEqual({ type: 'welcome', protocol: 1, hub: 'vscode', version: '0.2.0', features: ['settings'] });
    expect(parseHubMessage('{"type":"updateSettings","patch":{"enabled":false}}')).toEqual({
      type: 'updateSettings',
      patch: { enabled: false },
    });
    expect(parseHubMessage('{"type":"command","id":1,"command":"release","pauseId":"p"}')).toEqual({
      type: 'command',
      id: 1,
      command: 'release',
      pauseId: 'p',
    });
    const oldStatus = { phase: 'playing', enabled: true, browserConnected: true, tutorialTitle: null, resumeAt: null };
    expect(parseHubMessage(JSON.stringify({ type: 'status', status: oldStatus }))).toMatchObject({
      status: { settings: null },
    });
    expect(parseEditorMessage('{"type":"control","action":"toggleEnabled"}')).toEqual({
      type: 'control',
      action: 'toggleEnabled',
    });
  });
});
