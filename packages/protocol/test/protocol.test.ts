import { describe, expect, it } from 'vitest';
import { describeStatus, parseBrowserMessage, parseEditorMessage, parseHubMessage, type HubStatus } from '../src/index';

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
  const base: HubStatus = { phase: 'coding', enabled: true, browserConnected: true, tutorialTitle: null, resumeAt: null };
  it('shows a countdown only when a resume is close', () => {
    expect(describeStatus(base, 0)).toBe('Coding...');
    expect(describeStatus({ ...base, resumeAt: 10_000 }, 0)).toBe('Coding...');
    expect(describeStatus({ ...base, resumeAt: 2_100 }, 0)).toBe('Coding... (resume in 3s)');
  });
});
