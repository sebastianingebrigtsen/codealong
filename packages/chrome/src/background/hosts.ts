/**
 * Sites where the content script is declared statically in manifest.json (keep in sync).
 * On these, iframes created later (e.g. a Vimeo player inserted by an SPA) get an agent
 * automatically. Other sites are injected on demand when the user follows a tab.
 */
const STATIC_HOSTS = ['youtube.com', 'youtube-nocookie.com', 'vimeo.com', 'laracasts.com'];

export function isStaticallyCovered(url: string): boolean {
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    host = u.hostname;
  } catch {
    return false;
  }
  return STATIC_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}
