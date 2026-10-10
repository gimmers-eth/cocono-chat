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

// Mirrors be/.env defaults; the SERVER is the authority and answers 413 when
// these are exceeded — the point of checking here is to say so in one tap's
// time and in human words, not to enforce anything.
export const MEDIA_MAX_BYTES = 10 * 1024 * 1024;
export const MEDIA_THUMB_MAX_BYTES = 64 * 1024;
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

export function revokeAllObjectUrls() {
  for (const scope of [...urlScopes.keys()]) releaseScope(scope);
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
  if (kind === 'file' && byteLength > MEDIA_MAX_BYTES) {
    throw new MediaReject(`That file is ${formatSize(byteLength)} — attachments are limited to ${formatSize(MEDIA_MAX_BYTES)}.`);
  }
  if (byteLength > MEDIA_MAX_BYTES) {
    throw new MediaReject(`That is ${formatSize(byteLength)} — the limit is ${formatSize(MEDIA_MAX_BYTES)}.`);
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

/** Poster frame for a video: seek to 0 (or a hair in, some encoders deliver a
 *  black frame at exactly 0) and paint it to a canvas. Best effort — a video
 *  that will not decode locally simply sends without a poster. */
async function videoPoster(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.src = url;
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve;
      video.onerror = () => reject(new Error('video decode failed'));
      setTimeout(resolve, 4000); // a silent/odd codec still gets a shot at a frame
    });
    if (!video.videoWidth) return null;
    if (video.duration > 0.1) { try { video.currentTime = Math.min(0.1, video.duration / 2); } catch { /* seek unsupported */ } }
    await new Promise((resolve) => {
      if (video.readyState >= 2) return resolve();
      video.onseeked = resolve;
      setTimeout(resolve, 3000);
    });
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, THUMB_MAX_EDGE / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    const out = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', THUMB_QUALITY));
    const dims = { w: video.videoWidth, h: video.videoHeight, dur: Number.isFinite(video.duration) ? video.duration : null };
    return out ? { thumb: out, ...dims } : null;
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
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
export async function prepareMedia(file) {
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
    const bytes = await readBytes(file);
    assertWithinLimits('video', bytes.length);
    const poster = await videoPoster(file);
    return {
      kind, mime, name, bytes,
      thumb: poster?.thumb ?? null,
      w: poster?.w ?? null, h: poster?.h ?? null, dur: poster?.dur ?? null, animated: false,
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

/** Records whose DECRYPTED bytes are past the local window and unpinned.
 *  `keep` (the viewer's 'Keep on this device') is the only exemption —
 *  re-download is impossible once the server deleted the blob, so a pinned
 *  record is a deliberate choice, not an oversight. */
export function pruneDue(records, { now = Date.now(), days = LOCAL_RETENTION_DAYS_DEFAULT } = {}) {
  const cutoff = now - Math.max(0, Number(days) || 0) * 86_400_000;
  return (records ?? []).filter((r) => r && r.state === 'stored' && r.keep !== true && Number(r.ts) < cutoff);
}

/** Dropping bytes keeps the record: name, size, date and direction stay (the
 *  transcript row never moves), only the payload goes. Images/videos KEEP
 *  their thumbnail so the wall still has something to show; a file's thumb is
 *  the icon the renderer draws anyway, so it goes with the bytes. */
export function prunePatch(rec) {
  const keepThumb = rec.kind === 'image' || rec.kind === 'video';
  return { data: null, thumb: keepThumb ? rec.thumb ?? null : null, state: 'pruned' };
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
    state: 'pending',      // nothing on this device yet (the sender's own row
                           // is written 'stored' by the caller — it made the bytes)
    keep: false,
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

export async function downloadMedia(client, row, { thumbOnly = false } = {}) {
  const blob = blobOf(row);
  if (!blob || !row?.key) return { ok: false, state: row?.state ?? 'failed' };
  // every write below is a PATCH, never a re-spread of a row read earlier:
  // updateMedia merges onto the CURRENT record, so a download that finishes
  // after the user pinned/blur-toggled the row keeps their choice
  await updateMedia(row.id, { state: 'downloading' });
  try {
    if (thumbOnly) {
      // a POSTER is not a download: the record keeps waiting for the user's
      // button (and the blob keeps waiting for that ack), only its preview
      // fills in
      const thumb = await client.downloadThumb(blob, row);
      await updateMedia(row.id, { thumb });
      return { ok: true, state: row.state, thumbOnly: true };
    }
    const { data, thumb } = await client.downloadMedia(blob, row);
    await updateMedia(row.id, { data, ...(thumb ? { thumb } : {}), state: 'stored' });
    // ack AFTER the bytes are safely on the device: that is what lets the
    // server delete the blob (req 8)
    await client.ackMedia(blob, true).catch(() => {});
    return { ok: true, state: 'stored' };
  } catch (err) {
    const gone = err?.code === 'unknown_media' || err?.status === 404;
    await updateMedia(row.id, { state: gone ? 'expired' : 'failed' });
    // a gone blob is settled: ack it so the server-side pending set can empty
    // (the copy is unrecoverable, holding it pending helps nobody)
    if (gone) await client.ackMedia(blob, true).catch(() => {});
    return { ok: false, state: gone ? 'expired' : 'failed', error: err };
  }
}

/** Apply the receive policy to one fresh record. */
export async function applyArrivalPolicy(client, row) {
  if (autoDownload(row.kind)) return downloadMedia(client, row);
  if (autoDownloadThumb(row.kind)) {
    // video poster: a thumb-only fetch never acks — the full bytes still
    // wait behind the Download button, and the blob must survive until then
    return downloadMedia(client, row, { thumbOnly: true });
  }
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
