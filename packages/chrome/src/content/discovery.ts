/**
 * Finds every <video> in a document, including those inside open shadow roots.
 *
 * Modern players built from web components (e.g. Mux Player on Laracasts: <mux-player> ->
 * shadow root -> <mux-video> -> shadow root -> <video>) hide the element from
 * document.querySelectorAll. Closed shadow roots stay out of reach by design.
 */
export function findVideos(root: Document | ShadowRoot = document): HTMLVideoElement[] {
  const found: HTMLVideoElement[] = [];
  const visit = (scope: Document | ShadowRoot): void => {
    found.push(...Array.from(scope.querySelectorAll('video')));
    const walker = (scope instanceof Document ? scope : scope.ownerDocument).createTreeWalker(
      scope,
      NodeFilter.SHOW_ELEMENT,
    );
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const shadow = (node as Element).shadowRoot;
      if (shadow) visit(shadow);
    }
  };
  visit(root);
  return found;
}
