// client-side media preparation + policy (M4). The SDK does crypto and
// transport and has no DOM; THIS module is the DOM half: read the picked
// file, resize it, make the thumbnail, decide kind/blur/pruning — and hand
// plain bytes to `client.sendMedia()`.
//
// Why resizing happens here at all: a phone photo is 4–8 MB and would hit the
// 10 MB ciphertext cap (and the account quota) at full size, exactly like the
// profile avatar that is resized to 128 px before upload. The server cannot
// check any of this — it holds ciphertext — so these caps are the ONLY thing
// between a user's gallery and a full quota; the server re-enforces them as
// the authority (be/src/routes/app-routes/media.js).
//
// Everything that can be tested without a browser is a pure function here
// (kind detection, limits, name sanitising, link extraction, blur policy,
// prune policy, tab filtering) — the canvas/video plumbing only runs at
// pick time.

import { getMedia, updateMedia, allMedia } from './store.js';
import { logEvent } from './applog.js';
import { transcodeVideo, transcodedName, primeAudioContext, TRANSCODE_ENABLED } from './transcode.js';
import { stageMedia, unstageMedia } from './vidstage.js';

// STARTING values only. The server advertises the real ones in
// `/api/app-info.media` (setMediaLimits below) — a limit duplicated in two
// places is two places to be wrong, and at 100 MB the difference between "we
// refuse it politely" and "the request died" is visible to the user.
export const MEDIA_MAX_BYTES = 100 * 1024 * 1024;
export const MEDIA_THUMB_MAX_BYTES = 64 * 1024;
// (declared after the constants it copies: a `const` above them reads them in
// the temporal dead zone and takes the whole module down at import time)
const limits = { maxBytes: MEDIA_MAX_BYTES, jsonMaxBytes: 8 * 1024 * 1024, thumbMaxBytes: MEDIA_THUMB_MAX_BYTES, quotaMb: 500, retentionDays: null };

/** Adopt the server's media limits (main.js calls this on boot; a stale or
 *  missing answer simply keeps the defaults above). */
export function setMediaLimits(info) {
  if (!info || typeof info !== 'object') return limits;
  if (Number(info.maxBytes) > 0) limits.maxBytes = Number(info.maxBytes);
  if (Number(info.jsonMaxBytes) > 0) limits.jsonMaxBytes = Number(info.jsonMaxBytes);
  if (Number(info.thumbMaxBytes) > 0) limits.thumbMaxBytes = Number(info.thumbMaxBytes);
  if (Number(info.quotaMb) > 0) limits.quotaMb = Number(info.quotaMb);
  if (Number(info.retentionDays) > 0) limits.retentionDays = Number(info.retentionDays);
  return limits;
}
export const mediaLimits = () => ({ ...limits });
export const limitText = () => formatSize(limits.maxBytes);
export const IMAGE_MAX_EDGE = 1600;   // longest edge after resize
export const THUMB_MAX_EDGE = 256;    // bubble/wall preview
export const NAME_MAX_LEN = 120;
export const JPEG_QUALITY = 0.85;
export const THUMB_QUALITY = 0.7;
// local retention for DECRYPTED bytes (settings drawer value; records and
// transcript rows always stay — only the bytes are dropped)
export const LOCAL_RETENTION_DAYS_DEFAULT = 7;

// A Blob URL lives as long as the document unless someone revokes it, and
// chat.js re-renders on every keystroke-level event. One registry PER SCOPE:
// 'bubbles' is released before each re-render, 'viewer' when the modal closes.
// Never across the two — that would blank an open viewer the moment a new
// message arrived (and a leaked URL is megabytes of decrypted file, not a
// string).
const urlScopes = new Map(); // scope -> Set<url>

export function objectUrl(blob, scope = 'bubbles') {
  if (!blob) return '';
  const url = URL.createObjectURL(blob);
  if (!urlScopes.has(scope)) urlScopes.set(scope, new Set());
  urlScopes.get(scope).add(url);
  return url;
}

/** Release (and forget) every URL handed out for one scope. */
export function releaseScope(scope) {
  const set = urlScopes.get(scope);
  if (!set) return;
  for (const url of set) {
    try { URL.revokeObjectURL(url); } catch { /* already revoked */ }
  }
  set.clear();
}

/**
 * Ask a media element for the frame a tenth of a second in, so a clip with no
 * poster shows a PICTURE instead of a black box.
 *
 * This exists because the obvious spelling — a `#t=0.1` media fragment on the
 * src — is a WebKit trap: Safari answers `MEDIA_ERR_SRC_NOT_SUPPORTED` (code 4)
 * for a `blob:` URL carrying a fragment, so the element that a phone had just
 * decoded a poster from refused to load at all. Chromium accepts the fragment,
 * which is why this looked like "the sender cannot play it, the recipient can".
 * A seek after `loadedmetadata` is the same request in a form every engine
 * takes, and it is what the poster ladder has always done on these same phones.
 * Never fatal: a clip that will not seek still plays from zero.
 */
export function seekToFirstFrame(el, at = 0.1) {
  const go = () => { try { if (!el.currentTime) el.currentTime = at; } catch { /* unseekable */ } };
  if ((el.readyState ?? 0) >= 1) go();
  else el.addEventListener?.('loadedmetadata', go, { once: true });
  return el;
}

/** m:ss for a video length (shared by the bubble badge and the wall tile —
 *  two call sites that must not disagree about what '0:07' means). */
export function durationText(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export const formatSize = (bytes) => {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};

export class MediaReject extends Error {
  constructor(message) { super(message); this.name = 'MediaReject'; this.code = 'media_reject'; }
}

/**
 * image/* → image, video/* → video, anything else → file.
 * SVG is refused outright: it is a SCRIPT-BEARING image format and our origin
 * must never render one, decrypted or not (the CSP cannot save us from a
 * same-origin Blob URL full of <script>).
 */
export function detectKind(mime) {
  const m = String(mime ?? '').toLowerCase();
  if (m === 'image/svg+xml' || m === 'image/svg') throw new MediaReject('SVG images are not supported (they can carry code).');
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  return 'file';
}

/**
 * Is it safe to hand these bytes to an <img>? The SENDER's picker refuses SVG
 * (detectKind), but a descriptor is untrusted input: a modified client can
 * claim kind 'image' with SVG bytes, and SVG is a script-bearing format. The
 * rule is therefore enforced at RENDER time too, on both ends — an image that
 * claims to be SVG paints as a file row (a name and a download), never as a
 * picture. (An <img> cannot run script from an SVG today; that is a browser
 * guarantee we refuse to rely on for a same-origin Blob URL.)
 */
export const renderableAsImage = (row) => !!row
  && row.kind === 'image' && !/svg/i.test(String(row.mime ?? ''));

export const isAnimatedMime = (mime) => {
  const m = String(mime ?? '').toLowerCase();
  return m === 'image/gif' || m === 'image/webp' || m === 'image/avif';
};

/** Strip any path components, collapse whitespace, cap the length. A filename
 *  arrives from the SENDER and is untrusted display text at the receiver —
 *  it is only ever assigned via textContent, never a URL. */
export function sanitizeName(name) {
  const base = String(name ?? '').split(/[\\/]/).pop() ?? '';
  const clean = base.replace(/\s+/g, ' ').trim();
  return clean ? clean.slice(0, NAME_MAX_LEN) : `attachment-${Date.now()}`;
}

/** The one gate every kind passes before any crypto or upload happens. */
export function assertWithinLimits(kind, byteLength) {
  const cap = limits.maxBytes;
  if (byteLength > cap) {
    throw new MediaReject(kind === 'file'
      ? `That file is ${formatSize(byteLength)} — attachments are limited to ${formatSize(cap)}.`
      : `That is ${formatSize(byteLength)} — the limit is ${formatSize(cap)}.`);
  }
  if (byteLength === 0) throw new MediaReject('That file is empty.');
}

const readBytes = async (blob) => new Uint8Array(await blob.arrayBuffer());

/** Canvas downscale + JPEG re-encode, longest edge ≤ maxEdge. Returns null
 *  when the image cannot be decoded (or is smaller than the cap and needs no
 *  work, decided by the caller via `needsResize`). */
async function resizeImage(blob, maxEdge, quality, type = 'image/jpeg') {
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  const out = await new Promise((resolve) => canvas.toBlob(resolve, type, quality));
  return out ? { blob: out, w, h } : null;
}

/** 256 px preview, re-scaled again if the encoded thumb is still chunky — the
 *  thumb cap is small because it is what EVERY device pulls for the wall.
 *  NEVER fatal: a thumbnail that will not render just means the bubble shows
 *  an icon instead of a preview (the full bytes are unaffected). */
async function makeThumb(source, maxEdge = THUMB_MAX_EDGE) {
  try {
    let out = await resizeImage(source, maxEdge, THUMB_QUALITY);
    if (out && out.blob.size > MEDIA_THUMB_MAX_BYTES) out = await resizeImage(source, Math.round(maxEdge / 2), 0.6);
    return out?.blob ?? null;
  } catch {
    return null;
  }
}

/**
 * WHERE to take a frame from, in order (pure, so the reasoning is testable
 * without a phone in the loop).
 *
 * A clip routinely OPENS on black — fades, and iOS handing back an empty buffer
 * at t≈0 for HEVC — so one timestamp is not a strategy: the ladder walks into
 * the clip. `duration` is Infinity for some MP4s whose moov carries none (older
 * WebKit) and NaN while metadata is pending, so the guard matters as much as
 * the order.
 */
export function posterSeekTimes(duration) {
  const d = Number(duration);
  if (!Number.isFinite(d) || d <= 0) return [0.1, 1];          // unknown length: blind probes
  // ascending, de-duplicated, and always inside the clip: a seek past the last
  // frame never fires `seeked` on some engines, which stalls the whole ladder on
  // one dead promise
  return [...new Set([
    Math.min(0.1, d / 2),
    Math.min(0.5, d / 4),
    d / 2,
    Math.max(0, d - 0.5),
  ].map((v) => Math.min(d, Math.max(0, Math.round(v * 100) / 100))))]
    .sort((a, b) => a - b);
}

/**
 * Is this frame blank? (pure over raw pixels). A poster of solid black reads as
 * a broken attachment, so a blank candidate is discarded and the ladder moves
 * on; if every candidate is blank there is no poster, and the film icon is the
 * honest answer. Every 7th pixel is enough to tell, cheaply.
 */
export function looksBlank(pixels) {
  if (!pixels || !pixels.length) return true;
  let first = null;
  let lit = 0;
  for (let i = 0; i + 3 < pixels.length; i += 4 * 7) {
    const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
    if ((r + g + b) / 3 > 12) lit += 1;
    const bucket = `${r >> 4},${g >> 4},${b >> 4}`;
    if (first === null) first = bucket;
    else if (bucket !== first) return false;    // any structure at all: a real frame
  }
  return lit === 0;
}

/** The first of several events, or a deadline — a stalled decoder must never
 *  hang a send the user is waiting on. */
function waitOnce(target, events, ms) {
  return new Promise((resolve) => {
    const handlers = {};
    const off = () => { for (const e of events) target.removeEventListener?.(e, handlers[e]); };
    const done = (what) => { off(); resolve(what); };
    for (const e of events) {
      handlers[e] = () => done(e);
      target.addEventListener?.(e, handlers[e]);
    }
    setTimeout(() => done('timeout'), ms);
  });
}

const canvasBlob = (canvas, quality) => new Promise((resolve) => {
  try { canvas.toBlob((blob) => resolve(blob ?? null), 'image/jpeg', quality); }
  catch { resolve(null); }
});

/**
 * Grab a decodable frame out of a video and return a JPEG poster.
 *
 * This exists because the previous version failed SILENTLY and permanently: it
 * used `preload: 'metadata'`, waited 4 s for metadata iOS does not deliver that
 * way, found `videoWidth === 0`, returned null — and every video in the dev
 * database proves a poster has NEVER been captured from that phone
 * (`thumbCtSize: null` on all 14). A video with no poster is invisible in the
 * thread, so this is worth a ladder of attempts rather than one hope.
 *
 * Per candidate timestamp, in order of reliability:
 *   1. `requestVideoFrameCallback` (Safari 15.4+, Chrome) — the only API that
 *      promises a frame that was actually PRESENTED;
 *   2. `createImageBitmap(video)` — engines that refuse to draw a paused element;
 *   3. `drawImage(video)` after `seeked`.
 * A frame is accepted only when it is not blank, so a clip that opens on black
 * still gets a real preview from a second in. `why` comes back on failure and is
 * logged: three rounds of phone testing were guesswork precisely because the
 * failure had no voice.
 */
export async function grabVideoFrame(blob, { maxEdge = THUMB_MAX_EDGE, quality = THUMB_QUALITY, log = null } = {}) {
  // journalled as well as printed: a poster that fails SILENTLY is the bug that
  // cost three rounds of phone testing, and the report a user sends is the only
  // place a phone's failure can ever be read
  const note = (m) => {
    try { (log ?? ((x) => console.warn(x)))(m); } catch { /* no console */ }
    try { logEvent('poster', String(m).replace('[media] ', '').replace('video poster: ', '')); } catch { /* never fatal */ }
  };
  // no DOM, no decoder: this function IS a browser capability, and the pipeline
  // tests run the arrival policy headlessly
  if (typeof document === 'undefined') return { thumb: null, why: 'no-dom' };
  let url = '';
  const video = document.createElement('video');
  // Every failure below is SAYABLE: a poster that fails silently is the bug that
  // cost three rounds of phone testing, and the reason is the only part of this
  // function a report can carry home.
  const fail = (why) => { note(`[media] video poster: no preview (${why})`); return { thumb: null, why }; };
  try {
    url = URL.createObjectURL(blob);
    video.preload = 'auto';                 // 'metadata' is the bug: iOS withholds dimensions
    // ATTACHED, and attached BEFORE src is assigned, or WebKit hands back blank
    // frames (and sometimes no metadata at all): a detached <video> is not a
    // decoder iOS will feed. See vidstage.js.
    stageMedia(video);
    video.src = url;
    video.load?.();                         // some engines only begin on an explicit load()
    const meta = await waitOnce(video, ['loadedmetadata', 'loadeddata', 'canplay', 'error'], 12000);
    if (meta === 'error') return fail('decode-error');
    if (!video.videoWidth) {
      try { video.currentTime = 0.1; } catch { /* unseekable */ }
      await waitOnce(video, ['seeked', 'loadeddata', 'canplay'], 3000);
      if (!video.videoWidth) return fail('no-dimensions');
    }
    const w = video.videoWidth, h = video.videoHeight;
    const dur = Number.isFinite(video.duration) ? video.duration : null;
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, maxEdge / Math.max(w, h));
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const g = canvas.getContext?.('2d');
    if (!g) return fail('no-2d-context');

    // WebKit will not hand a PAUSED element's frames to a canvas until its
    // decoder has actually run once, so run it: muted + playsinline + attached
    // is the combination iOS allows without a gesture. A refused play() is not
    // fatal — the ladder below is what decides.
    try {
      await Promise.race([
        video.play().then(() => waitOnce(video, ['playing', 'timeupdate'], 700)),
        new Promise((resolve) => setTimeout(resolve, 800)),
      ]);
      video.pause();
    } catch { /* autoplay policy: the ladder still tries */ }

    let fallback = null;
    for (const t of posterSeekTimes(dur)) {
      try { video.currentTime = t; } catch { break; }
      const how = await frameArrived(video, t);
      const painted = await paintFrame(video, canvas, g);
      if (!painted) continue;
      fallback = fallback ?? painted;
      if (!painted.blank) {
        const out = await canvasBlob(canvas, quality);
        if (out) { note(`[media] video poster captured at ${t}s via ${painted.via}/${how}`); return { thumb: out, w, h, dur }; }
      }
    }
    // every frame we could read was blank: no poster beats a black lie
    return fail(fallback ? 'blank-frames' : 'undrawable');
  } catch (err) {
    note(`[media] video poster threw: ${err?.message ?? err}`);
    return { thumb: null, why: 'threw' };
  } finally {
    // release the decoder promptly: a stranded <video> on a phone holds the
    // codec and the memory of the clip it just decoded
    unstageMedia(video);
    if (url) setTimeout(() => { try { URL.revokeObjectURL(url); } catch { /* gone */ } }, 1000);
  }
}

/** How the frame became available (for the log): rvfc | bitmap | seeked | … */
async function frameArrived(video, wantTime) {
  if (typeof video.requestVideoFrameCallback === 'function') {
    const raced = await Promise.race([
      new Promise((resolve) => { try { video.requestVideoFrameCallback(() => resolve('rvfc')); } catch { resolve(null); } }),
      new Promise((resolve) => setTimeout(() => resolve(null), 2500)),
    ]);
    if (raced) return raced;
  }
  if ((video.readyState ?? 0) >= 2 && Math.abs((video.currentTime ?? 0) - wantTime) < 0.6) return 'ready';
  const ev = await waitOnce(video, ['seeked', 'timeupdate', 'canplay'], 2500);
  return ev === 'timeout' ? 'seek-timeout' : ev;
}

async function paintFrame(video, canvas, g) {
  try {
    if (typeof createImageBitmap === 'function') {
      try {
        const frame = await Promise.race([
          createImageBitmap(video),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2500)),
        ]);
        g.drawImage(frame, 0, 0, canvas.width, canvas.height);
        frame.close?.();
        const px = g.getImageData?.(0, 0, canvas.width, canvas.height).data ?? null;
        return { blank: px ? looksBlank(px) : false, via: 'bitmap' };
      } catch { /* this engine will not bitmap a paused element: fall through */ }
    }
    g.drawImage(video, 0, 0, canvas.width, canvas.height);
    const px = g.getImageData?.(0, 0, canvas.width, canvas.height).data ?? null;
    return { blank: px ? looksBlank(px) : false, via: 'drawImage' };
  } catch {
    return null;                          // decoder refused; the next timestamp may not
  }
}

/**
 * Turn a picked File into what `client.sendMedia()` wants:
 *   { kind, mime, name, bytes, thumb, w, h, dur, animated }
 *
 * Rules (plan §6.3): images are downscaled to ≤1600 px and re-encoded JPEG
 * q≈0.85 (PNG with alpha that is already small stays PNG); animated GIF/WebP
 * pass through UNTOUCHED (canvas would kill the animation); videos are never
 * transcoded (a poster frame is captured instead); everything else is bytes
 * as-is. Throws MediaReject with the sentence the user sees.
 */
export async function prepareMedia(file, { onPhase = null } = {}) {
  const name = sanitizeName(file?.name);
  const mime = String(file?.type ?? '');
  const kind = detectKind(mime);

  if (kind === 'image') {
    const bytes = await readBytes(file);
    assertWithinLimits(kind, bytes.length);
    const animated = isAnimatedMime(mime);
    // Animated GIF/WebP/AVIF pass through UNTOUCHED: a canvas would flatten
    // them to one frame, and 'animated' is what the viewer's Play/Pause
    // control exists for. They still get a first-frame poster for the wall.
    if (animated) {
      const thumb = await makeThumb(file);
      return { kind, mime, name, bytes, thumb, animated: true };
    }
    let dims = null;
    try {
      const bmp = await createImageBitmap(file);
      dims = { w: bmp.width, h: bmp.height };
      bmp.close?.();
    } catch { /* undecodable: the resize below reports it */ }
    const edge = dims ? Math.max(dims.w, dims.h) : IMAGE_MAX_EDGE + 1;
    // already small AND already modestly sized: send the original bytes, a
    // re-encode would only lose quality (this is what keeps a small PNG's
    // alpha instead of grinding it into JPEG)
    if (edge <= IMAGE_MAX_EDGE && file.size <= MEDIA_MAX_BYTES / 8) {
      const thumb = await makeThumb(file);
      return { kind, mime, name, bytes, thumb, w: dims?.w ?? null, h: dims?.h ?? null, animated: false };
    }
    const resized = await resizeImage(file, IMAGE_MAX_EDGE, JPEG_QUALITY);
    if (!resized) throw new MediaReject('That image could not be read — try another file.');
    const finalBytes = await readBytes(resized.blob);
    assertWithinLimits(kind, finalBytes.length);
    const thumb = await makeThumb(resized.blob);
    return {
      kind, mime: 'image/jpeg', name: name.replace(/\.[^.]*$/, '') + '.jpg',
      bytes: finalBytes, thumb, w: resized.w, h: resized.h, animated: false,
    };
  }

  if (kind === 'video') {
    // The camera's own file is what gets sent (see TRANSCODE_ENABLED for the
    // evidence): the re-encode is off, so no decoder, no AudioContext and no
    // real-time wait sit between the tap and the upload. When it is switched on
    // it runs FIRST, so the poster below is cut from a stream this engine chose,
    // and a null (unsupported, too long, any failure) falls back to the original
    // file — a clip must never be lost, or delayed forever, to make it
    // compatible.
    let source = file;
    let outMime = mime;
    let outName = name;
    onPhase?.('preparing');
    if (TRANSCODE_ENABLED) {
      // Opened HERE, as close to the user's tap as we can get: engines may refuse
      // an AudioContext created later inside an awaited transcode, and a suspended
      // context records silence (which we refuse to send).
      const audioCtx = primeAudioContext();
      // progress is forwarded: a re-encode records in real time, so a 30-second
      // clip is 30 seconds of work the user has to be able to see.
      const re = await transcodeVideo(file, { audioCtx, onProgress: (frac) => onPhase?.('transcoding', frac) });
      if (re) {
        source = re;
        outMime = 'video/mp4';                  // the descriptor must not lie about
        outName = transcodedName(name);         // what the recipient is being sent
      }
    }
    const bytes = await readBytes(source);
    assertWithinLimits('video', bytes.length);
    // Worth a ladder: a video with no poster is invisible in the thread, and a
    // failed preview must never fail the SEND. If capture gives up, the payload
    // still goes and the recipient builds the poster from the bytes they now
    // have (buildPoster) — a labelled tile meanwhile.
    const poster = await grabVideoFrame(source);
    return {
      kind, mime: outMime, name: outName, bytes,
      thumb: poster.thumb ?? null,
      w: poster.w ?? null, h: poster.h ?? null, dur: poster.dur ?? null, animated: false,
      posterWhy: poster.thumb ? null : poster.why,
    };
  }

  const bytes = await readBytes(file);
  assertWithinLimits('file', bytes.length);
  return { kind: 'file', mime, name, bytes, thumb: null, animated: false };
}

// ---------------- policy: what lands on the device, and how it looks ----------------

/** Auto-download policy (req 5/6): images arrive by themselves; a video only
 *  pulls its POSTER (the full bytes wait for the Download button); a file
 *  waits entirely. */
export const autoDownload = (kind) => kind === 'image';
export const autoDownloadThumb = (kind) => kind === 'image' || kind === 'video';

/**
 * A VIDEO whose payload is small enough to fetch without asking.
 *
 * The poster is built from BYTES this device holds, and a sender whose browser
 * could not decode the clip sends no poster at all — so 'wait for the tap' used
 * to mean 'the thread shows a grey icon for a phone clip that costs 300 KB'.
 * Under this size the payload comes on arrival and the preview appears; over it,
 * fetching someone's 100 MB clip unprompted would be rude of us.
 */
export const VIDEO_AUTO_MAX_BYTES = 8 * 1024 * 1024;
export const autoFetchVideo = (row) => !!row && row.kind === 'video'
  && Number(row.size) > 0 && Number(row.size) <= VIDEO_AUTO_MAX_BYTES;

/**
 * Blur decision for an already-DECRYPTED image (req 7 is a DISPLAY rule, not
 * a download rule — the bytes are on the device either way):
 *   - anything I sent: never blurred (it is my own content);
 *   - an explicit per-record override wins;
 *   - otherwise: sender flagged identity-verified by the admin → clear,
 *     unverified OR unknown → blurred.
 * `verified` is the cached peer fact (IDB `peers`), read at render time.
 */
export function isBlurred(rec, verified) {
  if (rec?.dir === 'out') return false;
  if (rec?.blurred === true || rec?.blurred === false) return rec.blurred;
  return verified !== true;
}

/**
 * When the app may throw away a copy it holds. Two independent triggers
 * (product rule, 2026-10):
 *
 *   1. the retention window has passed — measured from `storedAt`, when the
 *      bytes LANDED on this device, not from `ts`; and
 *   2. the item has already been handed to the phone (`savedAt`): the person
 *      owns a copy in Files/Downloads, so the app's duplicate is pure weight.
 *
 * The old 'Keep on this device' pin is gone: with rule 2 the user has a
 * stronger, ordinary thing — they saved the file — and a second way to
 * accumulate invisible data forever was not worth its label confusion. (A
 * leftover `keep: true` on a record written by an older build is IGNORED here,
 * deliberately: nothing may become un-prunable because a feature moved on.)
 *
 * `ts` stays what it always was: the media's position in the conversation.
 */
export function pruneDue(records, { now = Date.now(), days = LOCAL_RETENTION_DAYS_DEFAULT } = {}) {
  const cutoff = now - Math.max(0, Number(days) || 0) * 86_400_000;
  return (records ?? []).filter((r) => r && r.state === 'stored'
    && (Number(r.savedAt) > 0 || Number(r.storedAt ?? r.ts) < cutoff));
}

/** Dropping bytes keeps the record: name, size, date and direction stay (the
 *  transcript row never moves), only the payload goes. Images/videos KEEP
 *  their thumbnail so the wall still has something to show; a file's thumb is
 *  the icon the renderer draws anyway, so it goes with the bytes. */
/**
 * Dropping the bytes keeps everything the user can still act on: the
 * transcript row, the name/size/date, and for a picture or a video the
 * thumbnail (the wall would otherwise empty out). A file's thumb goes with its
 * bytes because the row draws an icon anyway.
 */
export function prunePatch(rec) {
  const keepThumb = rec.kind === 'image' || rec.kind === 'video';
  return {
    data: null,
    thumb: keepThumb ? rec.thumb ?? null : null,
    state: 'pruned',
    // WHY this copy is gone, decided at prune time while the facts are fresh
    prunedWhy: Number(rec.savedAt) > 0 ? 'saved' : 'age',
  };
}

// ---------------- the hand-off to the DEVICE (req 3/6's last step) ----------------

// "Download" in this app has always meant *server → this device's encrypted
// store*. That is only half of what a person means by the word: on a phone a
// file you cannot open has not been downloaded at all. Everything below is the
// second half — handing the decrypted bytes back to the OS.

/** Does this device hold the bytes? 'expired'/'pruned'/'declined' rows do not,
 *  and no wording should pretend a save is possible. */
export const hasLocalBytes = (row) => !!row?.data && Number(row.data.size ?? 0) > 0;

const EXT_BY_MIME = {
  'image/jpeg': 'jpg', 'image/pjpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/avif': 'avif', 'video/mp4': 'mp4', 'video/quicktime': 'mov',
  'video/webm': 'webm', 'application/pdf': 'pdf', 'text/plain': 'txt', 'text/csv': 'csv',
  'application/zip': 'zip', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a',
};

/**
 * A filename the OS can actually act on. The sender's name is untrusted
 * display text: path separators and the characters filesystems fight over are
 * stripped (same rule as the transcript's sanitiser, stricter because this
 * name reaches a filesystem), and an extension is guaranteed — a photo saved
 * as "IMG_0142" with no .jpg opens in nothing, which is exactly the complaint
 * this function exists to prevent.
 */
export function deviceFileName(row) {
  const raw = String(row?.name ?? '')
    .split(/[\\/]/).pop()
    .replace(/[\u0000-\u001f:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const kind = row?.kind;
  let name = raw || (kind === 'image' ? 'photo' : kind === 'video' ? 'video' : 'file');
  if (!/\.[A-Za-z0-9]{1,8}$/.test(name)) {
    const ext = EXT_BY_MIME[String(row?.mime ?? '').toLowerCase()] ?? '';
    if (ext) name = `${name}.${ext}`;
  }
  return name.slice(0, 180);
}

/**
 * Hand the decrypted bytes to the phone: a real DOWNLOAD (an `<a download>` on
 * the Blob URL), which is what the user asked for. The Web Share sheet used to
 * be the preferred door and is not: on a phone it opens a sheet, "does not
 * save the file", and puts a chooser where a result should be. Sharing is still
 * reachable from the file once it is in Files, so nothing is lost by removing
 * it from this button.
 *
 * Writes `savedAt` on success — that stamp is what lets the retention job
 * release the app's own duplicate (rule 2 of `pruneDue`).
 *
 * `how` is reported because a save nobody confirms is indistinguishable from a
 * broken button: 'saved' (download started), 'unsupported' (no anchor
 * download in this engine — the caller then offers the fallback), 'failed'.
 */
export async function saveToDevice(row) {
  if (!hasLocalBytes(row)) return { ok: false, how: 'none' };
  const name = deviceFileName(row);
  // Its OWN URL, outside the bubble/viewer scopes: a re-render or a closed
  // modal must never revoke the address a save is mid-flight on.
  let url = '';
  try {
    const a = document.createElement('a');
    // Probe BEFORE assigning: `a.download = x` CREATES the property, so an
    // `'download' in a` check afterwards is true in every engine and the
    // unsupported branch becomes code that can never run (my own test caught
    // exactly this). The anchor also must not be built before we know it works.
    if (!('download' in a)) return { ok: false, how: 'unsupported', name };
    url = URL.createObjectURL(row.data);
    a.href = url;
    a.download = name;          // the filename the OS stores it under
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.append(a);
    a.click();
    a.remove();
    await updateMedia(row.id, { savedAt: Date.now() });
    return { ok: true, how: 'saved', name };
  } catch (error) {
    logEvent('save', `download refused: ${String(error?.message ?? error).slice(0, 80)}`);
    return { ok: false, how: 'failed', error };
  } finally {
    // Long enough for a big write to hand off, short enough that a failed save
    // cannot strand the bytes in the tab forever.
    if (url) setTimeout(() => { try { URL.revokeObjectURL(url); } catch { /* gone */ } }, 10_000);
  }
}

/**
 * Last-resort door for engines that swallow `<a download>` (iOS in an
 * installed PWA is the case). Separate on purpose: Save is the normal button,
 * this one only appears when Save could not happen, so the user is never asked
 * to choose between two words for the same thing.
 */
export async function shareToDevice(row) {
  if (!hasLocalBytes(row)) return { ok: false, how: 'none' };
  const name = deviceFileName(row);
  const type = String(row.mime ?? '').trim() || 'application/octet-stream';
  let file = row.data;
  try {
    file = new File([row.data], name, { type, lastModified: Number(row.ts) || Date.now() });
  } catch { /* no File constructor: a Blob still shares on most engines */ }
  try {
    if (typeof navigator?.share !== 'function' || navigator.canShare?.({ files: [file] }) !== true) {
      return { ok: false, how: 'unsupported', name };
    }
    await navigator.share({ files: [file], title: name });
    await updateMedia(row.id, { savedAt: Date.now() });
    return { ok: true, how: 'shared', name };
  } catch (error) {
    if (error?.name === 'AbortError') return { ok: false, how: 'cancelled' };
    return { ok: false, how: 'failed', error };
  }
}

/**
 * A send the app did not live to finish. The draft row still says
 * preparing/uploading and its message still says sending, but nothing is running
 * any more — the tab closed, the phone slept, the PWA was killed. Left alone it
 * is a progress bar that never moves, which is worse than a failure: a failure
 * is a fact the user can act on.
 *
 * The bytes are still on this device, so the row settles the way a failed upload
 * does (the local copy is kept) and the MESSAGE is marked failed by the caller —
 * that mark is what says "this never went". Returns the message ids to settle.
 */
export async function reapStaleDrafts() {
  const rows = await allMedia();
  const stale = (rows ?? []).filter((r) => r && (r.state === 'preparing' || r.state === 'uploading'));
  const ids = [];
  for (const r of stale) {
    try {
      await updateMedia(r.id, { state: hasLocalBytes(r) ? 'stored' : 'failed', progress: 0 });
      if (r.msgId) ids.push(r.msgId);
    } catch { /* one bad row must not stop the rest */ }
  }
  if (ids.length) logEvent('media', `reaped ${ids.length} unfinished send(s)`);
  return ids;
}

/**
 * Make a video into a PICTURE, on the device that holds the bytes.
 *
 * The sender's poster is best-effort — their browser may refuse to decode a
 * phone recording at all (normal on iOS) — and with none, the recipient's
 * bubble showed a film icon that reads as 'the video never arrived'. Once the
 * payload is local we can decode it OURS and take the frame, so the bubble, the
 * wall and the <video> poster all get real pixels.
 *
 * Never fatal: an undecodable video still downloads, still plays where the
 * engine can, and simply keeps its icon.
 */
export async function buildPoster(row) {
  if (!row || row.kind !== 'video' || !hasLocalBytes(row)) return null;
  if (row.thumb && row.thumb.size) return row.thumb;      // the sender did manage one
  const src = new Blob([row.data], { type: String(row.mime ?? '').trim() || 'video/mp4' });
  const got = await grabVideoFrame(src);
  if (!got.thumb) return null;
  await updateMedia(row.id, {
    thumb: got.thumb,
    ...(got.w ? { w: got.w, h: got.h } : {}),
    ...(got.dur ? { dur: got.dur } : {}),
  });
  return got.thumb;
}

// ---------------- the conversation tabs (req 1/4) ----------------

/** One entry per URL in a message, in order, de-duplicated per message. */
export function extractLinks(text) {
  const out = [];
  const seen = new Set();
  const re = /https?:\/\/[^\s<>"'`]+/gi;
  let m;
  while ((m = re.exec(String(text ?? ''))) !== null) {
    let url = m[0];
    // trailing punctuation is prose, not part of the link
    url = url.replace(/[),.;!?*:]+$/, '');
    let host = '';
    try { host = new URL(url).hostname; } catch { continue; }
    if (!host || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, host });
  }
  return out;
}

/** Split a conversation's messages + media into what each tab shows. Pure
 *  (no DOM, no store) so the tab rules are testable: images/videos are the
 *  media rows of that kind, FILES are non-image/non-video media (a video is
 *  not a file), LINKS are URLs pulled out of every text message. */
export function tabBuckets(messages, mediaRows) {
  const byId = new Map((mediaRows ?? []).map((r) => [r.id, r]));
  const rowsFor = (kind) => (messages ?? [])
    .map((m) => (m.mediaId ? byId.get(m.mediaId) : null))
    .filter((r) => r && r.kind === kind)
    .sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
  const files = (messages ?? [])
    .map((m) => (m.mediaId ? byId.get(m.mediaId) : null))
    .filter((r) => r && r.kind !== 'image' && r.kind !== 'video')
    .sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
  const links = [];
  for (const m of messages ?? []) {
    if (m.dir === 'sys' || m.mediaId || !m.text) continue;
    for (const l of extractLinks(m.text)) links.push({ ...l, ts: m.ts, peer: m.peer, dir: m.dir, snippet: String(m.text).slice(0, 120) });
  }
  links.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
  return { images: rowsFor('image'), videos: rowsFor('video'), files, links };
}

/** Files-tab search (req 4's "searchable list") — name + kind, client-side. */
export function filterMedia(rows, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return rows ?? [];
  return (rows ?? []).filter((r) => String(r.name ?? '').toLowerCase().includes(q));
}

// ---------------- the media RECORD ----------------

/** The server blob a row points at, or null when there is none yet (an
 *  outgoing row whose upload has not landed). EVERY wire call goes through
 *  this and refuses politely on null — never `row.id`, which for a sender is
 *  a local key the server has never heard of. */
export const blobOf = (row) => (typeof row?.blobId === 'string' && row.blobId ? row.blobId : null);

/** Read a transcript line's plaintext as a media descriptor, or null. Same
 *  defensive shape as the {"sys":…} path: a quick prefix test, a try/catch
 *  parse, and an unparsable or structureless payload is a TEXT message (never
 *  a crash and never a half-rendered bubble). */
/** What a media message SAYS in every place that shows a line of text (the
 *  sidebar preview, a notification, the report transcript): a label, never a
 *  JSON blob and never '[object Object]'. */
export function mediaLabel(kind, name) {
  if (kind === 'video') return 'Video';
  if (kind === 'file') return `File: ${String(name ?? '').trim() || 'attachment'}`;
  return 'Photo';
}

export function parseMediaPayload(text) {
  if (typeof text !== 'string' || !/^\{"media":/.test(text)) return null;
  try {
    const p = JSON.parse(text);
    const m = p?.media;
    if (!m || typeof m !== 'object' || typeof m.id !== 'string' || typeof m.key !== 'string') return null;
    return m;
  } catch {
    return null;
  }
}

/**
 * The IDB `media` row for a descriptor. `dir` is 'in' (a peer's send) or
 * 'out' (mine, or a SYNC copy of mine mirrored from another of my devices);
 * `state:'pending'` means the bytes are NOT on this device yet.
 */
export function mediaRow({ key, blobId = key, peer, dir, kind, media, msgId, ts }) {
  return {
    // `id` is this device's row key; `blobId` is the SERVER blob that
    // download/ack address. They are the same record for an incoming message;
    // an OUTGOING one is keyed by the sender's own id because it is written
    // before the upload answers with a blob id (req 4: the sender keeps their
    // copy even if the send dies) — and blobId is null until it lands.
    id: key,
    blobId: blobId ?? null,
    peer: String(peer ?? '').toLowerCase(),
    dir,
    kind,
    name: sanitizeName(media?.name ?? ''),
    mime: String(media?.mime ?? ''),
    size: Number(media?.size) || 0,
    key: media?.key ?? null,
    iv: media?.iv ?? null,
    thumbIv: media?.thumbIv ?? null,
    sha256: media?.sha256 ?? null,
    w: media?.w ?? null, h: media?.h ?? null, dur: media?.dur ?? null,
    animated: media?.animated === true,
    // `keep` is RETIRED (see pruneDue): a record written by an older build may
    // still carry keep:true, and the sweep ignores it — nothing may become
    // un-prunable because a feature moved on.
    state: 'pending',      // nothing on this device yet (the sender's own row
                           // is written 'stored' by the caller — it made the bytes)
    storedAt: null,        // when the bytes ARRIVED here: the prune clock
                           // (ts is the conversation position, a different thing)
    savedAt: null,         // when they were handed to the PHONE — after that
                           // the app's copy is weight, not a holding (prune rule 2)
    prunedWhy: null,       // 'saved' | 'age': why a pruned row says what it says

    blurred: null,         // null = no override, use the verified-flag default
    data: null,
    thumb: null,
    msgId,
    ts: ts ?? Date.now(),
  };
}

// ---------------- the download engine (req 5/6/8) ----------------

// Images arrive by themselves; a video pulls ONLY its poster (a 10 MB wait for
// a button); a file waits entirely. Every fetch failure lands in `failed` and
// is retried on the next socket open — `expired` (404: the blob is gone) is
// final and is acked anyway, because an un-acked device would pin a dead
// reference forever and break req 8.
const RETRY_BATCH = 4;

/**
 * Fetch a payload and put it on this device — resumably, with progress.
 *
 * A 100 MB file on mobile data is not a request, it is a project. So:
 *   * every chunk received is appended to `parts` and the running total is
 *     written to the record (`partial`, `partialBytes`) — if the app dies mid
 *     fetch, the bytes it paid for are still there;
 *   * a dropped connection retries from that offset (HTTP Range) instead of
 *     starting over, with a short backoff, and only the errors that CANNOT be
 *     fixed by retrying (404 gone, tampered) end the attempt;
 *   * `progress` (0…1) rides on the record so the bubble and the viewer can
 *     show a real bar rather than a spinner that might be wrong.
 *
 * Verification is deliberately at the END, over the whole ciphertext: the
 * digest is of the ciphertext, so a resumed download that stitched a bad
 * offset together fails here and is never acked.
 */
const RESUME_ATTEMPTS = 4;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function downloadMedia(client, row, { thumbOnly = false, onProgress = null } = {}) {
  const blob = blobOf(row);
  if (!blob || !row?.key) return { ok: false, state: row?.state ?? 'failed' };
  try {
    if (thumbOnly) {
      // A POSTER is decoration. It must never touch `state` and above all must
      // never ACK: the fetch that writes the lifecycle is the full download
      // (req 8). Earlier code ran the poster through the same failure path as a
      // real download, so a video sent without a preview got a 404 on
      // ?part=thumb, was read as "the blob is gone", and the recipient's own
      // ack DELETED the video for everyone.
      if (!row.thumbIv) return { ok: false, skipped: 'no-thumb', state: row.state, thumbOnly: true };
      try {
        const thumb = await client.downloadThumb(blob, row);
        await updateMedia(row.id, { thumb });
        return { ok: true, state: row.state, thumbOnly: true };
      } catch (err) {
        return { ok: false, state: row.state, thumbOnly: true, error: err };
      }
    }
    await updateMedia(row.id, { state: 'downloading' });
    const ct = await fetchResumable(client, blob, row, { onProgress });
    const media = { key: row.key, sha256: row.sha256, mime: row.mime };
    const data = await client.decryptMediaBytes(ct, media);
    let thumb = row.thumb ?? null;
    if (row.thumbIv && !thumb) {
      try { thumb = await client.downloadThumb(blob, row); } catch { thumb = null; }
    }
    await updateMedia(row.id, {
      data, ...(thumb ? { thumb } : {}),
      state: 'stored', storedAt: Date.now(),
      progress: 0, partial: null, partialBytes: 0,      // the resume scrap is done with
    });
    if (row.kind === 'video' && !thumb) buildPoster({ ...row, data, state: 'stored' }).catch(() => null);
    // ack AFTER the bytes are safely on the device: that is what lets the
    // server delete the blob (req 8)
    await client.ackMedia(blob, true).catch(() => {});
    return { ok: true, state: 'stored' };
  } catch (err) {
    // 'no_thumb' is deliberately NOT 'gone': a missing preview says nothing
    // about the payload, and the code below would ack it away
    const gone = err?.code === 'unknown_media' || (err?.status === 404 && err?.code !== 'no_thumb');
    await updateMedia(row.id, {
      state: gone ? 'expired' : 'failed',
      progress: 0,
      ...(gone ? { partial: null, partialBytes: 0 } : {}),
    });
    // the CODE is the useful part: 'download failed' tells a user nothing, while
    // media_tampered vs unknown_media vs a plain network drop tells us everything
    logEvent('media', `${row.kind} ${gone ? 'gone from server' : 'download failed'} code=${err?.code ?? err?.name ?? '?'}`);
    // a gone blob is settled: ack it so the server-side pending set can empty
    // (the copy is unrecoverable, holding it pending helps nobody)
    if (gone) await client.ackMedia(blob, true).catch(() => {});
    return { ok: false, state: gone ? 'expired' : 'failed', error: err };
  }
}

/**
 * The resume loop. `row.partial` is where a previous attempt stopped (it may
 * be minutes or days old, and a different session); each retried request starts
 * at that byte, so nothing already paid for is fetched twice.
 */
function noop() {}

async function fetchResumable(client, blobId, row, { onProgress } = {}) {
  // `?? noop`, NOT a default parameter: the caller passes `onProgress: null`
  // when nobody is watching (the auto-download on arrival), and a default only
  // fills in for `undefined` — so the first progress callback threw
  // 'onProgress is not a function' and every incoming image landed in
  // 'failed'. The bug was invisible to a stub that never called the callback.
  const report = typeof onProgress === 'function' ? onProgress : noop;
  const parts = [];
  let cursor = 0;
  if (row.partial && Number(row.partialBytes) > 0) {
    parts.push(row.partial);
    cursor = Number(row.partialBytes);
  }
  let lastError = null;
  for (let attempt = 0; attempt < RESUME_ATTEMPTS; attempt++) {
    try {
      await client.fetchMediaBytes(blobId, {
        start: cursor,
        onChunk: (bytes) => {
          parts.push(new Blob([bytes]));
          cursor += bytes.length;
        },
        onProgress: (got, total) => {
          report(got, total);                  // the viewer's bar, live
          const p = total ? Math.min(1, got / total) : 0;
          // throttled to ~2 % steps: an IDB write per 64 KB chunk would be a
          // thousand writes for one file, and the bar cannot show the difference
          if (Math.abs((row.progress ?? 0) - p) >= 0.02 || p >= 1) {
            row.progress = p;
            updateMedia(row.id, { progress: p }).catch(() => {});
          }
        },
      });
      const buf = await new Blob(parts).arrayBuffer();
      return new Uint8Array(buf);
    } catch (err) {
      lastError = err;
      // unrecoverable by definition: retrying a fetch of bytes that no longer
      // exist, or of bytes that fail the digest, only wastes the user's data
      if (err?.code === 'unknown_media' || err?.code === 'no_thumb' || err?.code === 'media_tampered'
        || err?.code === 'upload_incomplete' || err?.status === 404) throw err;
      // keep what arrived, then back off and continue from the new offset
      await updateMedia(row.id, { partial: new Blob(parts), partialBytes: cursor, progress: row.progress ?? 0 }).catch(() => {});
      if (attempt < RESUME_ATTEMPTS - 1) await sleep(1000 * (attempt + 1));
    }
  }
  throw lastError ?? new Error('download failed');
}

/** Apply the receive policy to one fresh record. */
export async function applyArrivalPolicy(client, row) {
  if (autoDownload(row.kind)) return downloadMedia(client, row);
  // a small video comes right over: that is what makes a preview exist at all
  // when the sender's browser could not capture a frame (see autoFetchVideo)
  if (row.kind === 'video' && autoFetchVideo(row)) return downloadMedia(client, row);
  if (autoDownloadThumb(row.kind)) {
    // video poster: a thumb-only fetch never acks — the full bytes still
    // wait behind the Download button, and the blob must survive until then
    return downloadMedia(client, row, { thumbOnly: true });
  }
  // a file has no preview to pull and no permission to fetch itself: the
  // record waits for the user's Download (or Delete), state untouched
  return { ok: true, state: row.state };
}

/** Retry queue: everything that failed (NOT expired/declined) for THIS
 *  account, a few at a time, on the next open. Hammering the download
 *  limiter would only make every later blob slower, so the batch is small. */
export async function retryFailedDownloads(client, { limit = RETRY_BATCH } = {}) {
  const rows = (await allMedia()).filter((r) => r.state === 'failed');
  const batch = rows.slice(0, limit);
  for (const row of batch) await downloadMedia(client, row);
  return batch.length;
}

/** Decline (req 6: "delete it before downloading" = mark received). */
export async function declineMedia(client, row) {
  const blob = blobOf(row);
  await updateMedia(row.id, { data: null, state: 'declined' });
  if (!blob) return { ok: true };   // nothing on the server to settle
  try {
    await client.ackMedia(blob, false);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err };
  }
}

/** Local retention sweep (§4.5): drop the BYTES of old unpinned records, keep
 *  the record and the transcript. Images/videos keep their thumbnail so the
 *  wall still has a picture; a file's icon is drawn anyway. */
export async function pruneLocalMedia({ now = Date.now(), days = null } = {}) {
  const window = days ?? localRetentionDays();
  const due = pruneDue(await allMedia(), { now, days: window });
  for (const rec of due) await updateMedia(rec.id, prunePatch(rec));
  return due.length;
}

export const LOCAL_RETENTION_KEY = 'cocono.media.retentionDays';
export const localRetentionDays = () => {
  const n = Number(localStorage.getItem(LOCAL_RETENTION_KEY) || 0);
  return n >= 1 ? n : LOCAL_RETENTION_DAYS_DEFAULT;
};
export const setLocalRetentionDays = (n) => {
  localStorage.setItem(LOCAL_RETENTION_KEY, String(Math.max(1, Math.min(365, Number(n) || LOCAL_RETENTION_DAYS_DEFAULT))));
};
