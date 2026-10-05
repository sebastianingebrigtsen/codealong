/**
 * Decides which editor events count as "the user is coding". Kept free of the vscode module so
 * it can be unit tested, and as the single place to plug in smarter filtering later (e.g. only
 * files that belong to the tutorial project).
 */

export interface DocumentLike {
  uri: { scheme: string };
}

export interface ChangeEventLike {
  document: DocumentLike;
  contentChanges: readonly unknown[];
}

export interface EditorContext {
  activeDocument: DocumentLike | undefined;
  windowFocused: boolean;
}

/**
 * Schemes for real code. Excludes output panes, git views, settings.json (`vscode-userdata`, so
 * tweaking CodeAlong's own settings does not pause the video) and other virtual documents.
 */
const TRACKED_SCHEMES = new Set(['file', 'untitled', 'vscode-remote', 'vscode-notebook-cell']);

export function isTrackedDocument(doc: DocumentLike): boolean {
  return TRACKED_SCHEMES.has(doc.uri.scheme);
}

/**
 * A change counts only if it happens in the document the user is looking at, while this VS Code
 * window has focus. That filters out formatters on other files, git checkouts reloading files,
 * file watchers and AI agents editing in the background.
 */
export function isUserEdit(e: ChangeEventLike, ctx: EditorContext): boolean {
  return (
    e.contentChanges.length > 0 &&
    ctx.windowFocused &&
    ctx.activeDocument === e.document &&
    isTrackedDocument(e.document)
  );
}

/** Leading-edge throttle: the first call goes through at once, bursts are thinned out. */
export function createThrottle(intervalMs: number, now: () => number = Date.now): () => boolean {
  let last = -Infinity;
  return () => {
    const t = now();
    if (t - last < intervalMs) return false;
    last = t;
    return true;
  };
}
