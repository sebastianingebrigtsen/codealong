import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Shared secret for VS Code windows that join the hub as followers. Stored in a file that only
 * the current OS user can read. Any window may create it; the file appears atomically (written
 * to a temp file, then hard-linked into place) so a racing window never reads a partial token.
 */
export function loadOrCreateEditorToken(dir = path.join(os.homedir(), '.codealong')): string {
  const file = path.join(dir, 'editor-token');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const existing = readToken(file);
  if (existing) return existing;

  const tmp = path.join(dir, `editor-token.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  fs.writeFileSync(tmp, randomBytes(32).toString('hex'), { mode: 0o600 });
  try {
    fs.linkSync(tmp, file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    // Another window won the race, or the existing file is unusable: replace an unusable one.
    if (!readToken(file)) fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  const token = readToken(file);
  if (!token) throw new Error(`Could not create CodeAlong token file at ${file}`);
  return token;
}

function readToken(file: string): string | null {
  try {
    const token = fs.readFileSync(file, 'utf8').trim();
    return /^[0-9a-f]{64}$/.test(token) ? token : null;
  } catch {
    return null;
  }
}
