// A hidden <video> that is INSIDE the document, for the two jobs that need a
// real decoder: cutting a poster frame (media.js grabVideoFrame) and
// re-encoding a clip (transcode.js).
//
// WHY IT MUST BE ATTACHED. WebKit does not hand decoded frames to a media
// element that is not in the document: `drawImage()`/`createImageBitmap()` on a
// detached <video> come back blank and `play()` can refuse outright. That is
// the difference between "iOS refuses, send the original" and a real poster,
// and every video in the dev database had `thumbCtSize: null` — the poster
// ladder was running against a detached element on the one platform that
// records the format we most need a preview for.
//
// It is hidden the way a decoder still tolerates: 2×2 px, near-transparent,
// behind everything, no pointer events. `display:none` / `visibility:hidden`
// are NOT used — several engines suspend rendering (and therefore frame
// delivery) for an element that is not rendered at all.

/** Inline style for the staging element (exported so a test can assert it). */
export const STAGE_STYLE = [
  'position:fixed', 'left:0', 'top:0', 'width:2px', 'height:2px',
  'opacity:0.02', 'pointer-events:none', 'z-index:-1', 'object-fit:contain',
].join(';');

/**
 * Put a media element on the page (and mark the properties Safari reads as
 * ATTRIBUTES, not just as IDL properties). Returns the element, or `null` when
 * there is no document to put it in — callers then behave exactly as they did
 * before, which is the headless/test path.
 */
export function stageMedia(el) {
  if (!el || typeof document === 'undefined') return null;
  try {
    el.setAttribute('muted', '');
    el.setAttribute('playsinline', '');
    el.muted = true;
    el.playsInline = true;
    el.setAttribute('style', STAGE_STYLE);
    (document.body ?? document.documentElement)?.append(el);
    return el;
  } catch {
    return null;                              // staging is never fatal
  }
}

/** Take it back off and release the decoder. Idempotent. */
export function unstageMedia(el) {
  if (!el) return;
  try {
    el.pause?.();
    el.removeAttribute?.('src');
    el.load?.();                              // stops the fetch AND frees the codec
  } catch { /* already gone */ }
  try { el.remove?.(); } catch { /* not ours to remove */ }
}
