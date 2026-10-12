// Re-encode a phone video into the one format EVERY browser plays, on the
// sender's device, before it is uploaded.
//
// WHY THIS EXISTS. iPhone cameras write HEVC in a QuickTime `.mov`. Safari plays
// that; Chromium on desktop and most Android builds cannot (patent-encumbered
// decoder, not shipped), so a video that uploads perfectly shows the recipient
// "This video could not be played here". A preview is a separate problem (the
// poster ladder in media.js) — this is about the file itself.
//
// TWO CAPTURE ENGINES, because the obvious one is missing exactly where it is
// needed. `HTMLMediaElement.captureStream()` hands a recorder both tracks in one
// line of code — and WebKit does not implement it, i.e. the iPhone that produces
// every `.mov` we care about cannot use it. So the second engine draws the
// element into a <canvas> (requestVideoFrameCallback where it exists) and records
// `canvas.captureStream()`, which WebKit DOES implement, adding the audio track
// from a Web Audio graph. Same container out (H.264/AAC in MP4), one extra
// moving part.
//
// WHY MediaRecorder AND NOT the WebCodecs pipeline proposed earlier. WebCodecs
// gives fast, random-access transcoding of the VIDEO track only: carrying audio
// means demuxing the container and remuxing AAC sample-by-sample (an mp4box
// dependency plus the sample-table plumbing plus a muxer). The recorder gets
// sound in one pass and needs no dependency; the cost is wall-clock time, which
// is why the progress line exists and why long clips are left alone.
//
// EVERY path through this file falls back to the original file. A failed or
// unsupported transcode must never cost the user their video — and it must never
// quietly cost them the AUDIO either, so a clip that has a soundtrack we cannot
// capture is sent as recorded. Each outcome is journalled (applog) so a phone
// report says which path ran and why not: the skip reasons used to go only to
// console.warn, which is a voice nobody outside the room can hear.

import { logEvent } from './applog.js';
import { stageMedia, unstageMedia } from './vidstage.js';

/**
 * IS THE RE-ENCODE ON? No — and that is a decision with evidence behind it,
 * not a TODO.
 *
 * It was written for a real problem (a recipient whose browser cannot decode
 * HEVC), but that problem was never observed: every "cannot play" report turned
 * out to be a Content-Security-Policy with no `media-src`, which refused a
 * `blob:` <video> in EVERY browser before a decoder was consulted. Once the
 * header was fixed, the phones in this project played the clips — including
 * desktop Chromium, which decoded the HEVC/.mov well enough to hand back a
 * poster frame (`captured at 0.1s via bitmap/rvfc` in its own journal), because
 * Windows ships an HEVC decoder and Chromium uses it.
 *
 * What the re-encode DID do, once the CSP stopped masking it, was cost a send:
 * it records in real time (a 30 s clip is a 30 s wait), on battery, at a quality
 * loss, and it hangs if the engine leaves `play()` or `onstop` pending — which
 * is what it did, so the clip never reached the upload at all.
 *
 * So the default is: send the file the user's camera made, show its poster,
 * play it inline, and when an engine genuinely cannot decode it SAY so and offer
 * Save-to-device (mediaview.js). Flip this to true and everything below is still
 * here, bounded and journalled — but flip it because a recipient could not play
 * a clip, not because a codec name looks risky.
 */
export const TRANSCODE_ENABLED = false;

/** Max seconds we will re-encode at send time (real-time cost, battery). */
export const TRANSCODE_MAX_SECONDS = 90;
/** Hard ceiling on the whole re-encode, whatever the clip claims: a send must
 *  never be held hostage by an optional compatibility pass. */
export const TRANSCODE_DEADLINE_MS = 150_000;
/** Per-await ceilings: any one of these settling late must not stall the send. */
const PLAY_TIMEOUT_MS = 8_000;
const STOP_TIMEOUT_MS = 6_000;
/** Max payload after resizing — the app cap is the other gate, this is politeness. */
export const TRANSCODE_MAX_BYTES = 100 * 1024 * 1024;
/** Only transcode clips up to this resolution; beyond it a phone is doing more harm than the codec. */
export const TRANSCODE_MAX_EDGE = 1920;
/** Frames per second the canvas engine paints at (a phone clip is 30 fps). */
const CANVAS_FPS = 30;
const VIDEO_BITRATE = 6_000_000;
const AUDIO_BITRATE = 128_000;

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

/** HEVC brand list? (shared by 'does it need work' and 'is the OUTPUT right') */
const hevcBrands = (brands) => (brands ?? []).map((x) => String(x).toLowerCase())
  .some((x) => /^h(e|v)c[0-9]|hev[1c]|hevc|hvc1|hsxq|h265/.test(x));

/** HEVC in any clothing, or a QuickTime container: not safe to hand a stranger. */
export function needsTranscode({ mime, brands, container }) {
  const b = (brands ?? []).map((x) => x.toLowerCase());
  const hevc = hevcBrands(brands);
  const avc = b.some((x) => /^avc[0-9]|avc1|isom|mp4v|mp42|m4v |dash/.test(x)) && !hevc;
  if (hevc) return true;
  if (container === 'mov') return true;                     // QuickTime: Chromium plays almost none of them
  if (container === 'webm' || container === 'mkv') return false;   // VP8/VP9: plays everywhere except old Safari, and Safari can make them too
  if (/quicktime|hevc|h\.?265/i.test(mime ?? '')) return true;
  if (avc) return false;                                    // already H.264 in an MP4
  return true;                              // unknown: normalise it rather than gamble
}

/**
 * Is this blob H.264/AVC in an MP4 — the thing we PROMISED the recipient?
 * Stricter than `!needsTranscode` on purpose: a recorder is free to hand back
 * WebM whatever we asked for, and uploading that under a `.mp4` name is a lie
 * the recipient's player discovers.
 */
export function isPlayableMp4(bytes) {
  const info = sniffVideoFormat(bytes);
  return info.container === 'mp4' && !hevcBrands(info.brands);
}

/** Can this engine record the target at all? (pure so the gate is testable) */
export function pickRecorderType(isSupported) {
  return TARGET_TYPES.find((t) => { try { return isSupported(t); } catch { return false; } }) ?? null;
}

/**
 * What this engine can actually record with (a probe, not a decision — pure so a
 * test can pin the mapping without a browser).
 */
export function captureSupport(env = {}) {
  const g = env.globalThis ?? globalThis;
  const video = g.HTMLVideoElement?.prototype;
  const canvas = g.HTMLCanvasElement?.prototype;
  return {
    recorder: typeof g.MediaRecorder === 'function',
    // Chrome/Firefox: the element itself yields both tracks in one call.
    // WebKit: undefined — the reason the canvas engine exists.
    videoCapture: typeof video?.captureStream === 'function',
    canvasCapture: typeof canvas?.captureStream === 'function',
    videoFrames: typeof video?.requestVideoFrameCallback === 'function',
    mp4Type: typeof g.MediaRecorder?.isTypeSupported === 'function'
      ? pickRecorderType((t) => { try { return g.MediaRecorder.isTypeSupported(t); } catch { return false; } })
      : null,
  };
}

/**
 * Which engine to record with, or why there is none. Pure: this is the exact
 * sentence a phone report needs when a clip arrives as `.mov` again.
 */
export function captureEngine(support) {
  if (!support?.recorder) return { engine: null, why: 'no-mediarecorder' };
  if (!support?.mp4Type) return { engine: null, why: 'no-mp4-recorder' };
  if (support.videoCapture) return { engine: 'element', why: 'captureStream' };
  // Safari: paint frames into a canvas and record the canvas.
  if (support.canvasCapture) return { engine: 'canvas', why: 'canvas-capture' };
  return { engine: null, why: 'no-capture-engine' };
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
 */
export async function transcodeVideo(file, { onProgress = null, log = null, audioCtx = null, enabled = TRANSCODE_ENABLED, deadlineMs = null } = {}) {
  // EVERY branch journals: the reason a phone kept sending `.mov` was invisible
  // because the skip paths only warned to a console nobody was watching.
  const note = (m) => {
    try { (log ?? ((x) => console.warn(x)))(`[media] transcode: ${m}`); } catch { /* never fatal */ }
    try { logEvent('transcode', String(m).slice(0, 150)); } catch { /* never fatal */ }
  };
  let video = null;
  let url = '';
  let audio = null;
  let actx = audioCtx ?? null;      // may have been opened INSIDE the user gesture
  try {
    if (!enabled) { note('skipped (re-encode off: the camera file is sent as made)'); return null; }
    const mime = String(file?.type ?? '');
    const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
    const info = sniffVideoFormat(head);
    // decide on the CONTAINER first: an already-H.264 MP4 costs nothing, and a
    // phone that could not record mp4 costs nothing either — no element, no
    // decode, no battery. Only then is it worth loading a decoder.
    if (!needsTranscode({ mime, ...info })) { note('skipped (already universally playable)'); return null; }

    const support = captureSupport();
    const eng = captureEngine(support);
    if (!eng.engine) { note(`skipped (${eng.why})`); return null; }
    const type = support.mp4Type;

    url = URL.createObjectURL(file);
    video = document.createElement('video');
    video.preload = 'auto';
    // IN THE DOCUMENT BEFORE src IS ASSIGNED, or WebKit delivers no frames and
    // play() may refuse: that is the iPhone, i.e. the reason this file exists.
    stageMedia(video);
    video.src = url;

    const meta = await new Promise((resolve) => {
      const done = (v) => resolve(v);
      video.addEventListener('loadedmetadata', () => done(true), { once: true });
      video.addEventListener('error', () => done(false), { once: true });
      setTimeout(() => done(false), 12000);
    });
    if (!meta) { note('skipped (metadata never arrived)'); return null; }

    const dec = transcodeDecision({
      file, mime, info, dur: video.duration, width: video.videoWidth, height: video.videoHeight,
      hasRecorder: true, alreadyTarget: true,        // needsTranscode already said yes above
    });
    if (!dec.go) { note(`skipped (${dec.why})`); return null; }

    // Wall clock is the recorder's clock on BOTH engines, so playbackRate is not
    // a speed-up: at 2× it records a 2× clip half as long. Real time it is.
    //
    // DEADLINE around the whole recording, and a kill list the deadline can pull:
    // `await video.play()` and `await rec.onstop` are both promises an engine is
    // entitled never to settle (iOS leaves play() pending when it will not play;
    // a recorder that was never started never fires stop). Without this the
    // OPTIONAL compatibility pass could hold a user's send open forever — which
    // is exactly what it did: the clip never reached the upload at all.
    const ctl = { killed: false, cleanup: [] };
    const budget = Number(deadlineMs) > 0
      ? Number(deadlineMs)
      : Math.min(TRANSCODE_DEADLINE_MS, ((Number(video.duration) || 0) * 1000) + 45_000);
    const rec = await Promise.race([
      eng.engine === 'element'
        ? recordElement(video, type, onProgress, ctl)
        : recordCanvas(video, type, onProgress, note, (a) => { audio = a; actx = a?.ctx ?? actx; }, actx, ctl),
      new Promise((resolve) => setTimeout(() => {
        ctl.killed = true;
        for (const fn of ctl.cleanup) { try { fn(); } catch { /* best effort */ } }
        resolve({ blob: null, why: `deadline-${Math.round(budget / 1000)}s` });
      }, budget)),
    ]);
    if (!rec.blob) { note(`skipped (${rec.why})`); return null; }

    const out = rec.blob;
    if (!out.size || out.size < 1024) { note('skipped (empty output)'); return null; }
    // A recorder is free to hand back WebM whatever we asked for; uploading that
    // as `.mp4` would be a lie the recipient's player discovers.
    const outHead = new Uint8Array(await out.slice(0, 64).arrayBuffer());
    if (!isPlayableMp4(outHead)) { note('skipped (output is not a playable mp4)'); return null; }
    if (out.size >= file.size) {
      // a transcode bigger than the original is a pure loss (short clips with
      // fixed 6 Mbit overhead do this) — keep the original
      note(`skipped (output ${out.size} >= source ${file.size}), keeping the original`);
      return null;
    }
    onProgress?.(1, 1);
    const secs = Math.round(Number(video.duration) || 0);
    note(`ok ${secs}s ${file.size}->${out.size} via ${eng.engine}${rec.hadAudio === false ? ' (video only: no audio track in the source)' : ''}`);
    return out;
  } catch (err) {
    note(`failed ${err?.name ?? 'Error'} ${String(err?.message ?? err).slice(0, 90)}`);
    return null;
  } finally {
    try { actx?.close?.(); } catch { /* release */ }
    try { audio?.track?.stop?.(); } catch { /* release */ }
    unstageMedia(video);
    if (url) setTimeout(() => { try { URL.revokeObjectURL(url); } catch { /* gone */ } }, 1000);
  }
}

// ---------------- the two recording engines ----------------

/**
 * ENGINE 1 (Chrome/Firefox): the element's own captureStream, both tracks, no
 * canvas. `ondataavailable` every second so a long clip is never held in one
 * unbounded buffer.
 */
async function recordElement(video, type, onProgress, ctl) {
  let stream;
  try { stream = video.captureStream(); } catch { return { blob: null, why: 'captureStream threw' }; }
  if (!stream?.getVideoTracks?.().length) return { blob: null, why: 'no captured video track' };
  const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: VIDEO_BITRATE, audioBitsPerSecond: AUDIO_BITRATE });
  const parts = [];
  const stopped = new Promise((resolve) => { rec.onstop = resolve; });
  rec.ondataavailable = (e) => { if (e.data && e.data.size) parts.push(e.data); };
  rec.onerror = () => { /* the size/format checks in the caller catch a broken output */ };
  ctl?.cleanup.push(() => { try { rec.stop(); } catch { /* already stopped */ } });
  rec.start(1000);
  const played = await playThrough(video, onProgress, null, ctl);
  const bail = (why) => ({ blob: null, why });
  if (!played) { try { rec.stop(); } catch { /* already stopped */ } await withDeadline(stopped, STOP_TIMEOUT_MS); return bail('playback never started'); }
  try { rec.stop(); } catch { /* already stopped */ }
  // bounded: a recorder that never fires onstop must not become a stuck send
  await withDeadline(stopped, STOP_TIMEOUT_MS);
  if (ctl?.killed) return bail('deadline');
  return { blob: new Blob(parts, { type: 'video/mp4' }), hadAudio: stream.getAudioTracks?.().length > 0 };
}

/** A promise, or nothing after `ms` — for the awaits an engine may never settle. */
function withDeadline(promise, ms) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(resolve, ms))]);
}

/**
 * ENGINE 2 (WebKit, which has no element captureStream): paint each presented
 * frame into a canvas, record `canvas.captureStream()`, and take the soundtrack
 * from a Web Audio graph on the same element.
 *
 * A clip that HAS audio but whose audio we cannot capture is refused here
 * (`why: 'no audio capture'`) — the caller then sends the original. A silent
 * re-encode of someone's video is a worse loss than a `.mov`.
 */
async function recordCanvas(video, type, onProgress, note, giveAudio, ctxIn = null, ctl = null) {
  const w = video.videoWidth || 0, h = video.videoHeight || 0;
  if (!w || !h) return { blob: null, why: 'no dimensions' };
  const scale = Math.min(1, TRANSCODE_MAX_EDGE / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(2, Math.round(w * scale));
  canvas.height = Math.max(2, Math.round(h * scale));
  const g = canvas.getContext?.('2d');
  if (!g) return { blob: null, why: 'no-2d-context' };

  let stream;
  try { stream = canvas.captureStream(CANVAS_FPS); } catch { return { blob: null, why: 'canvas.captureStream threw' }; }
  if (!stream?.getVideoTracks?.().length) return { blob: null, why: 'canvas produced no video track' };

  const audio = await audioGraph(video, note, ctxIn);
  giveAudio?.(audio);
  if (audio.track) {
    try { stream.addTrack(audio.track); } catch { audio.track = null; }
  }

  const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: VIDEO_BITRATE, audioBitsPerSecond: AUDIO_BITRATE });
  const parts = [];
  const stopped = new Promise((resolve) => { rec.onstop = resolve; });
  rec.ondataavailable = (e) => { if (e.data && e.data.size) parts.push(e.data); };
  rec.onerror = () => { /* checked below */ };

  const draw = () => { try { g.drawImage(video, 0, 0, canvas.width, canvas.height); } catch { /* a frame the decoder withheld */ } };
  const painter = startPainter(video, draw);
  ctl?.cleanup.push(() => { try { painter.stop(); } catch { /* done */ } });
  rec.start(250);
  ctl?.cleanup.push(() => { try { rec.stop(); } catch { /* already stopped */ } });
  const played = await playThrough(video, onProgress, async () => {
    // A suspended AudioContext records SILENCE, and a silent re-encode of
    // someone's video is worse than the .mov we would otherwise send. Contexts
    // are often handed over suspended until something plays, so ask again now
    // that playback has started — and remember the answer.
    if (audio.ctx && audio.ctx.state !== 'running' && audio.ctx.state !== undefined) {
      try { await withDeadline(audio.ctx.resume?.() ?? Promise.resolve(), 3_000); } catch { /* refused */ }
      note(`audio context: ${audio.ctx.state}`);
    }
    audio.ran = audioRan(audio.ctx);
  }, ctl);
  // the last presented frame, then a beat for the recorder to flush it
  draw();
  await withDeadline(new Promise((r) => setTimeout(r, 250)), 400);
  painter.stop();
  if (!played) {
    try { rec.stop(); } catch { /* already stopped */ }
    await withDeadline(stopped, STOP_TIMEOUT_MS);
    return { blob: null, why: ctl?.killed ? 'deadline' : 'playback never started' };
  }
  try { rec.stop(); } catch { /* already stopped */ }
  // bounded, like the element engine: no onstop, no stuck send
  await withDeadline(stopped, STOP_TIMEOUT_MS);
  if (ctl?.killed) return { blob: null, why: 'deadline' };

  // A source WITH sound that we could not carry is not a transcode, it is an
  // edit.
  if (sourceHasAudio(video) && (!stream.getAudioTracks?.().length || audio.ran === false)) {
    return { blob: null, why: stream.getAudioTracks?.().length ? 'audio context stayed suspended' : 'source has audio, no audio capture' };
  }
  return { blob: new Blob(parts, { type: 'video/mp4' }), hadAudio: !!stream.getAudioTracks?.().length };
}

/**
 * Did the source clip have a soundtrack? Three signals, because none is
 * universal: WebKit and Blink expose `webkitAudioDecodedByteCount`, Gecko
 * `mozHasAudio`, and some builds an `audioTracks` list.
 */
export function sourceHasAudio(video) {
  if (Number(video?.webkitAudioDecodedByteCount ?? 0) > 0) return true;
  if (video?.mozHasAudio === true) return true;
  const tracks = video?.audioTracks;
  if (tracks && typeof tracks.length === 'number') return tracks.length > 0;
  return false;
}

/** Paint on every presented frame where the engine offers that (rvfc), else on
 *  a timer. Returns a handle whose `stop()` ends the loop. */
function startPainter(video, draw) {
  if (typeof video.requestVideoFrameCallback === 'function') {
    let live = true;
    const cb = () => {
      if (!live) return;
      draw();
      try { video.requestVideoFrameCallback(cb); } catch { live = false; }
    };
    try { video.requestVideoFrameCallback(cb); } catch { live = false; }
    if (live) return { stop: () => { live = false; } };
  }
  draw();
  const id = setInterval(draw, Math.round(1000 / CANVAS_FPS));
  return { stop: () => clearInterval(id) };
}

/**
 * Did the audio graph actually RUN? A suspended context records silence, and
 * silence over someone's clip is a worse outcome than the .mov we would
 * otherwise send. An engine that exposes no `state` at all is given the benefit
 * of the doubt — it is not telling us it is suspended.
 */
export function audioRan(ctx) {
  if (!ctx) return true;                        // no graph at all: the caller decides
  return ctx.state === undefined || ctx.state === 'running';
}

/**
 * Open (and try to unsuspend) an AudioContext NOW, while the user's tap still
 * counts. Engines are entitled to refuse a context created later, deep inside
 * an awaited transcode, and a suspended context records SILENCE — so the caller
 * that is still inside the gesture opens one and hands it down.
 * Returns null when this engine has no Web Audio at all.
 */
export function primeAudioContext() {
  try {
    const AC = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (!AC) return null;
    const ctx = new AC();
    try { ctx.resume?.()?.catch?.(() => {}); } catch { /* refused: audioGraph asks again */ }
    return ctx;
  } catch {
    return null;
  }
}

/**
 * The soundtrack, via Web Audio: `createMediaElementSource` reroutes the element
 * into a graph, and a MediaStreamDestination turns that back into a track the
 * recorder can take. Never fatal — `track: null` means "video only", and the
 * caller decides whether that is acceptable.
 */
async function audioGraph(video, note, ctxIn = null) {
  try {
    let ctx = ctxIn ?? null;
    if (!ctx) {
      const AC = globalThis.AudioContext ?? globalThis.webkitAudioContext;
      if (!AC) { note('no AudioContext here: this engine cannot carry the audio'); return { track: null, ctx: null, ran: true }; }
      ctx = new AC();
      // A phone may hand us a suspended context; a suspended graph records
      // silence. BOUNDED: resume() on iOS can stay pending forever without a
      // gesture, and this runs inside a send.
      try { await withDeadline(ctx.resume?.() ?? Promise.resolve(), 3_000); } catch { /* some engines refuse */ }
    }
    const src = ctx.createMediaElementSource(video);
    const dest = ctx.createMediaStreamDestination();
    src.connect(dest);                     // NOT to ctx.destination: no double audio
    const track = dest.stream?.getAudioTracks?.()[0] ?? null;
    if (!track) { note('audio graph produced no track'); return { track: null, ctx, ran: audioRan(ctx) }; }
    return { track, ctx, ran: audioRan(ctx) };
  } catch (err) {
    note(`audio capture unavailable: ${String(err?.message ?? err).slice(0, 60)}`);
    return { track: null, ctx: ctxIn ?? null, ran: false };
  }
}

/**
 * Play the clip to its end and say whether playback really started. `play()`
 * rejecting (autoplay policy, locked screen) is a SKIP, not a failure: the
 * original file goes, unchanged.
 */
async function playThrough(video, onProgress, onStarted = null, ctl = null) {
  const target = Number(video.duration) || 0;
  const tick = setInterval(() => {
    try { onProgress?.(Math.min(1, (video.currentTime || 0) / (target || 1))); } catch { /* ui hook */ }
  }, 250);
  ctl?.cleanup.push(() => clearInterval(tick));
  // the recorder is wall-clock, so this is the clip's own length plus slack for
  // a phone that decodes slower than it plays
  const deadline = (target * 1000) + 20_000;
  try {
    // BOUNDED: iOS leaves play() pending when it has decided not to play, and a
    // pending play() is a send that never happens.
    await withDeadline(video.play(), PLAY_TIMEOUT_MS);
    if (video.paused) return false;
  } catch {
    clearInterval(tick);
    return false;
  }
  try { await onStarted?.(); } catch { /* a hook must never kill the recording */ }
  try {
    await new Promise((resolve) => {
      video.addEventListener('ended', resolve, { once: true });
      const chk = setInterval(() => {
        if (video.ended || (target > 0 && (video.currentTime || 0) >= target - 0.05)) { clearInterval(chk); resolve(); }
      }, 150);
      ctl?.cleanup.push(() => clearInterval(chk));
      setTimeout(() => { clearInterval(chk); resolve(); }, deadline);
    });
  } finally {
    clearInterval(tick);
    try { video.pause(); } catch { /* done */ }
  }
  onProgress?.(1, 1);
  return true;
}

/** The name the recipient sees after a re-encode — a .mov on an mp4 lies. */
export function transcodedName(name) {
  // basename first: the sender's path components are already stripped upstream
  // and must not come back as dots in the name the recipient's Files app shows
  const base = String(name ?? '').split(/[\\/]/).pop() ?? '';
  const stem = base.replace(/\.[^.]*$/, '').replace(/\s+/g, ' ').replace(/[^\w -]/g, '').trim();
  return `${(stem || 'video').replace(/ +/g, '_')}.mp4`;
}
