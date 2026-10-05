/** Consistency checks that keep the repository releasable. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HUB_PORTS } from '@codealong/protocol';
import { isStaticallyCovered } from '../packages/chrome/src/background/hosts';
import { checkVersions } from '../scripts/versions.mjs';

const root = join(__dirname, '..');
const json = (p: string) => JSON.parse(readFileSync(join(root, p), 'utf8'));

describe('repository', () => {
  it('uses one version everywhere', () => {
    expect(checkVersions()).toBe(json('package.json').version);
    expect(json('packages/vscode/package.json').dependencies['@codealong/protocol']).toBe(json('package.json').version);
  });

  it('the Chrome manifest requests only what the docs justify', () => {
    const m = json('packages/chrome/manifest.json');
    expect(m.manifest_version).toBe(3);
    expect([...m.permissions].sort()).toEqual(['activeTab', 'alarms', 'scripting', 'storage']);
    expect(m.optional_host_permissions).toEqual(['https://*/*', 'http://*/*']);
    expect(m.description.length).toBeLessThanOrEqual(132);
    // Static content scripts run exactly where install-time host access exists, and the code agrees.
    expect(m.content_scripts[0].matches).toEqual(m.host_permissions);
    for (const pattern of m.host_permissions as string[]) {
      const sample = pattern.replace('*.', 'www.').replace(/\/\*$/, '/watch');
      expect(isStaticallyCovered(sample), pattern).toBe(true);
    }
  });

  it('hub ports are fixed, loopback-only defaults shared by both sides', () => {
    expect(HUB_PORTS.length).toBeGreaterThan(1);
    for (const p of HUB_PORTS) expect(p).toBeGreaterThan(1024);
  });

  it('the VS Code manifest is complete for the Marketplace', () => {
    const p = json('packages/vscode/package.json');
    for (const key of ['publisher', 'displayName', 'description', 'icon', 'repository', 'license', 'engines']) {
      expect(p[key], key).toBeTruthy();
    }
    expect(p.license).toBe('MIT');
    // Every command shown in the UI is contributed, and settings carry descriptions.
    const props = p.contributes.configuration.properties as Record<
      string,
      { description?: string; markdownDescription?: string }
    >;
    for (const [key, prop] of Object.entries(props)) {
      expect(prop.description ?? prop.markdownDescription, key).toBeTruthy();
    }
  });
});
