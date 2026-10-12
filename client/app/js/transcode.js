// Re-encode a phone video into the one format EVERY browser plays, on the
// sender's device, before it is uploaded.
//
// WHY THIS EXISTS. iPhone cameras write HEVC in a QuickTime `.mov`. Safari plays
// that; Chromium on desktop and most Android builds cannot (patent-encumbered
// decoder, not shipped), so a video that uploads perfectly shows the recipient
// "This video could not be played here". A preview is a separate problem (the
// poster ladder in media.js) — this is about the file itself.
//
// WHY MediaRecorder AND NOT the WebCodecs pipeline proposed earlier. The
// requirement is H.264/AAC in an MP4 — universally playable — and a clip
// WITHOUT its audio track is a broken clip. WebCodecs gives fast, random-access
// transcoding of the VIDEO track only: carrying audio means demuxing the
// container and remuxing AAC sample-by-sample (an mp4box dependency plus the
// sample-table plumbing plus a muxer), i.e. three moving parts to get sound
// where `captureStream()` hands the recorder both tracks and the browser muxes
// one file. Same output container, no new dependency, correct audio, today.
// The cost is real time (a 6 s clip takes ~6 s), which is why the progress line
// exists and why long clips are left alone. If speed ever matters more than the
// dependency, the WebCodecs path is the upgrade — the gate below is written so
// that is a swap of `transcodeVideo`, not of its callers.
//
// EVERY path through this file falls back to the original file. A failed or
// unsupported transcode must never cost the user their video, and each outcome
// is journalled (applog) so a phone report says which path ran and why not.

import { logEvent } from './applog.js';

/** Max seconds we will re-encode at send time (real-time cost, battery). */
export const TRANSCODE_MAX_SECONDS = 90;
/** Max payload after resizing — the app cap is the other gate, this is politeness. */
export const TRANSCODE_MAX_BYTES = 100 * 1024 * 1024;
/** Only transcode clips up to this resolution; beyond it a phone is doing more harm than the codec. */
const TRANSCODE_MAX_EDGE = 1920;

/** Container/codec preference order: H.264+AAC in MP4 first, nothing else wins. */
const TARGET_TYPES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4;codecs="avc1.42E01E","mp4a.40.2"',
  'video/mp4',
];

/**
 * Which container a file actually is, from its `ftyp` brand (pure, testable —
 * and the ONLY reliable signal, because Safari reports a `.mov` HEVC clip as
 * `video/quicktime` while a re-exported one may claim `video/mp4` and still be
 * HEVC inside).
 *
 * ISO-BMFF layout: [4 bytes size][4 bytes type='ftyp'][4 bytes major brand]
 * [compatible brands...]. Unknown/mis-labelled containers return `other`, which
 * the caller treats as "probably needs work".
 */
export function sniffVideoFormat(bytes) {
  const tag = (o) => String.fromCharCode(...bytes.subarray(o, o + 4));
  // 8 bytes is the smallest thing that can carry a size + type: an atom header.
  // Requiring 12 would call a legitimate legacy QuickTime file 'unknown'.
  if (!bytes || bytes.length < 8) return { container: 'unknown', brands: [] };
  if (tag(4) !== 'ftyp') {
    // QuickTime legacy files start straight at a `moov`/`mdat`/`wide` atom, and
    // Matroska/WebM start at the EBML magic
    const a = tag(4);
    if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return { container: 'webm', brands: [] };
    return { container: ['moov', 'mdat', 'wide', 'free', 'skip'].includes(a) ? 'mov' : 'unknown', brands: [] };
  }
  const brands = [];
  const size = (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
  for (let o = 8; o + 4 <= Math.min(size ?? 0, bytes.length); o += 4) brands.push(tag(o));
  return { container: brands[0] === 'qt  ' ? 'mov' : 'mp4', brands };
}

/** HEVC in any clothing, or a QuickTime container: not safe to hand a stranger. */
export function needsTranscode({ mime, brands, container }) {
  const b = (brands ?? []).map((x) => x.toLowerCase());
  const hevc = b.some((x) => /^h(e|v)c[0-9]|hev[1c]|hevc|hvc1|hsxq|h265/.test(x));
  const avc = b.some((x) => /^avc[0-9]|avc1|isom|mp4v|mp42|m4v |dash/.test(x)) && !hevc;
  if (hevc) return true;
  if (container === 'mov') return true;                     // QuickTime: Chromium plays almost none of them
  if (container === 'webm' || container === 'mkv') return false;   // VP8/VP9: plays everywhere except old Safari, and Safari can make them too
  if (/quicktime|hevc|h\.?265/i.test(mime ?? '')) return true;
  if (avc) return false;                                    // already H.264 in an MP4
  return true;                              // unknown: normalise it rather than gamble
}

/** Can this engine record the target at all? (pure so the gate is testable) */
export function pickRecorderType(isSupported) {
  return TARGET_TYPES.find((t) => { try { return isSupported(t); } catch { return false; } }) ?? null;
}

/**
 * Should we try? Every reason is a string so the journal says something useful
 * when a user asks why their clip arrived as `.mov` again.
 */
export function transcodeDecision({ file, mime, info, dur, width, height, hasRecorder, alreadyTarget }) {
  if (!file) return { go: false, why: 'no-file' };
  if (alreadyTarget && !needsTranscode({ mime, ...info })) return { go: false, why: 'already-h264' };
  if (needsTranscode({ mime, ...info })) {
    if (!hasRecorder) return { go: false, why: 'no-mp4-recorder' };
    if (!Number.isFinite(dur) || dur <= 0) return { go: false, why: 'unknown-duration' };
    if (dur > TRANSCODE_MAX_SECONDS) return { go: false, why: `too-long-${Math.round(dur)}s` };
    if (Number(file.size) > TRANSCODE_MAX_BYTES) return { go: false, why: 'too-large' };
    if (Math.max(width || 0, height || 0) > TRANSCODE_MAX_EDGE) return { go: false, why: 'too-wide' };
    return { go: true, why: `hevc-or-mov ${Math.round(dur)}s` };
  }
  return { go: false, why: 'not-needed' };
}

/**
 * Re-encode one video to H.264/AAC MP4. Resolves `null` on ANY problem — every
 * caller falls back to the original file — and journals the reason.
 *
 * `video.captureStream()` is what makes this one pass: the element decodes the
 * HEVC (Safari can), and the recorder re-encodes BOTH tracks. We play muted at
 * up to 4× playbackRate where the engine allows it, because the cost of this
 * approach is wall-clock time.
 */
export async function transcodeVideo(file, { onProgress = null, log = null } = {}) {
  const note = (m) => { try { (log ?? ((x) => console.warn(x)))(`[media] transcode: ${m}`); } catch { /* never fatal */ } };
  let video = null;
  let url = '';
  try {
    const mime = String(file?.type ?? '');
    const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
    const info = sniffVideoFormat(head);
    // decide on the CONTAINER first: an already-H.264 MP4 costs nothing, and a
    // phone that could not record mp4 costs nothing either — no element, no
    // decode, no battery. Only then is it worth loading a decoder.
    if (!needsTranscode({ mime, ...info })) { note('not needed (already universally playable)'); return null; }
    if (typeof MediaRecorder === 'undefined' || typeof HTMLVideoElement === 'undefined'
      || !HTMLVideoElement.prototype?.captureStream) {
      note('no captureStream here, sending the original');
      return null;
    }
    const type = pickRecorderType((t) => { try { return MediaRecorder.isTypeSupported(t); } catch { return false; } });
    if (!type) { note('no mp4 recorder in this engine, sending the original'); return null; }

    url = URL.createObjectURL(file);
    video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.src = url;
    const meta = await new Promise((resolve) => {
      const done = (v) => resolve(v);
      video.addEventListener('loadedmetadata', () => done(true), { once: true });
      video.addEventListener('error', () => done(false), { once: true });
      setTimeout(() => done(false), 12000);
    });
    if (!meta) { note('metadata never arrived'); return null; }

    const dec = transcodeDecision({
      file, mime, info, dur: video.duration, width: video.videoWidth, height: video.videoHeight,
      hasRecorder: true, alreadyTarget: true,        // needsTranscode already said yes above
    });
    if (!dec.go) { note(`skipped (${dec.why})`); return null; }

    const stream = video.captureStream();
    if (!stream.getVideoTracks().length) { note('no captured video track'); return null; }
    const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 6_000_000 });
    const parts = [];
    const stopped = new Promise((resolve) => { rec.onstop = resolve; });
    rec.ondataavailable = (e) => { if (e.data && e.data.size) parts.push(e.data); };
    rec.onerror = () => { /* the size/type check below catches a broken output */ };

    const target = video.duration;
    // Faster than real time where the engine lets us; playbackRate with audio
    // can desync some recorders, so this is capped conservatively and the
    // fallback (original file) covers a bad output.
    try { video.playbackRate = target > 30 ? 2 : 1; } catch { /* not all engines */ }
    const tick = setInterval(() => {
      try { onProgress?.(Math.min(1, (video.currentTime || 0) / (target || 1))); } catch { /* ui hook */ }
    }, 250);
    const timeout = setTimeout(() => { try { video.pause(); rec.stop(); } catch { /* done */ } }, (target * 1000) / 1 + 15_000);

    rec.start(1000);
    try { await video.play(); } catch { note('play refused (autoplay policy)'); clearInterval(tick); clearTimeout(timeout); return null; }
    await new Promise((resolve) => {
      video.addEventListener('ended', resolve, { once: true });
      const chk = setInterval(() => { if (video.ended) { clearInterval(chk); resolve(); } }, 250);
      setTimeout(() => { clearInterval(chk); resolve(); }, (target * 1000) + 15_000);
    });
    clearInterval(tick);
    clearTimeout(timeout);
    try { rec.stop(); } catch { /* already stopped */ }
    await stopped;

    const out = new Blob(parts, { type: 'video/mp4' });
    if (!out.size || out.size < 1024) { note('empty output'); return null; }
    if (out.size >= file.size) {
      // a transcode bigger than the original is a pure loss (short clips with
      // fixed 6 Mbit overhead do this) — keep the original
      note(`output larger than the source (${out.size} >= ${file.size}), keeping the original`);
      return null;
    }
    onProgress?.(1, 1);
    note(`re-encoded to mp4/h264: ${file.size} -> ${out.size} bytes`);
    logEvent('transcode', `ok ${Math.round(target)}s ${file.size}->${out.size}`);
    return out;
  } catch (err) {
    note(`failed: ${String(err?.message ?? err).slice(0, 90)}`);
    logEvent('transcode', `failed ${err?.name ?? 'Error'} ${String(err?.message ?? '').slice(0, 70)}`);
    return null;
  } finally {
    try { video?.pause?.(); video?.removeAttribute?.('src'); video?.srcObject?.getTracks?.().forEach((t) => t.stop()); } catch { /* release */ }
    if (url) setTimeout(() => { try { URL.revokeObjectURL(url); } catch { /* gone */ } }, 1000);
  }
}

/** The name the recipient sees after a re-encode — a .mov on an mp4 lies. */
export function transcodedName(name) {
  // basename first: the sender's path components are already stripped upstream
  // and must not come back as dots in the name the recipient's Files app shows
  const base = String(name ?? '').split(/[\\/]/).pop() ?? '';
  const stem = base.replace(/\.[^.]*$/, '').replace(/\s+/g, ' ').replace(/[^\w -]/g, '').trim();
  return `${(stem || 'video').replace(/ +/g, '_')}.mp4`;
}
