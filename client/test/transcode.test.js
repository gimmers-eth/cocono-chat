// The transcode decisions are pure and testable; the encoder is not (it needs a
// phone). Everything asserted here is the part that decides WHETHER to touch a
// user's video, which is the part that can quietly send 40 MB of re-encoded junk
// or silently skip a clip that needed work.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { installIdbShim } from './idbshim.js';
import { installDomShim } from './domshim.js';

// a DOM, so 'it never even created a <video>' is an assertion and not a hope
installIdbShim();
const dom = installDomShim(readFileSync(path.resolve(import.meta.dirname, '..', 'app', 'index.html'), 'utf8'));
import {
  sniffVideoFormat, needsTranscode, pickRecorderType, transcodeDecision,
  transcodedName, TRANSCODE_MAX_SECONDS,
} from '../app/js/transcode.js';

const fourcc = (s) => [...s].map((c) => c.charCodeAt(0));
const ftyp = (major, ...compat) => {
  const body = [...fourcc(major), ...compat.flatMap(fourcc)];
  return Uint8Array.from([0, 0, 0, 8 + body.length, ...fourcc('ftyp'), ...body]);
};
const atom = (type) => Uint8Array.from([0, 0, 0, 8, ...fourcc(type)]);

test('sniff: what container is this actually?', () => {
  assert.deepEqual(sniffVideoFormat(ftyp('qt  ', 'moov')).container, 'mov');
  assert.deepEqual(sniffVideoFormat(ftyp('isom', 'iso2', 'avc1', 'mp41')), { container: 'mp4', brands: ['isom', 'iso2', 'avc1', 'mp41'] });
  assert.deepEqual(sniffVideoFormat(ftyp('hev1', 'hev1')).container, 'mp4');
  assert.equal(sniffVideoFormat(atom('moov')).container, 'mov', 'legacy QuickTime has no ftyp');
  assert.equal(sniffVideoFormat(Uint8Array.from([0, 0, 0, 8, ...[...('moov')].map((c) => c.charCodeAt(0))])).container, 'mov');
  assert.equal(sniffVideoFormat(Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0])).container, 'webm');
  assert.equal(sniffVideoFormat(new Uint8Array(3)).container, 'unknown', 'a stub is not a video');
});

test('decide: HEVC and QuickTime go to the encoder, H.264 in mp4 does not', () => {
  assert.equal(needsTranscode({ mime: 'video/quicktime', ...sniffVideoFormat(ftyp('qt  ', 'moov')) }), true);
  assert.equal(needsTranscode({ mime: 'video/mp4', ...sniffVideoFormat(ftyp('hev1', 'hev1')) }), true);
  assert.equal(needsTranscode({ mime: '', ...sniffVideoFormat(ftyp('hvc1', 'hvc1')) }), true);
  assert.equal(needsTranscode({ mime: 'video/mp4', ...sniffVideoFormat(ftyp('isom', 'avc1', 'mp41')) }), false,
    'already universally playable — do not touch the user\'s file');
  assert.equal(needsTranscode({ mime: 'video/webm', ...sniffVideoFormat(atom('mdat')) }), true, 'mov container, even if the mime claims webm');
  assert.equal(needsTranscode({ mime: 'video/mp4', ...sniffVideoFormat(new Uint8Array(4)) }), true,
    'unknown container: normalise rather than gamble that the recipient can decode it');
});

test('gate: the reasons a clip is left alone are all sayable', () => {
  const base = { file: { size: 4_000_000 }, mime: 'video/quicktime', info: { container: 'mov', brands: ['qt  '] }, dur: 6, width: 1920, height: 1080, hasRecorder: true, alreadyTarget: false };
  assert.deepEqual(transcodeDecision(base), { go: true, why: 'hevc-or-mov 6s' });
  assert.equal(transcodeDecision({ ...base, dur: TRANSCODE_MAX_SECONDS + 40 }).why, 'too-long-130s');
  assert.equal(transcodeDecision({ ...base, file: { size: 200 * 1024 * 1024 } }).why, 'too-large');
  assert.equal(transcodeDecision({ ...base, width: 3840 }).why, 'too-wide');
  assert.equal(transcodeDecision({ ...base, hasRecorder: false }).why, 'no-mp4-recorder');
  assert.equal(transcodeDecision({ ...base, dur: Infinity }).why, 'unknown-duration',
    'no deadline can be computed for a clip of unknown length, so none is started');
  assert.equal(transcodeDecision({ ...base, mime: 'video/mp4', info: { container: 'mp4', brands: ['isom', 'avc1'] } }).why, 'not-needed');
});

test('recorder: only the target container counts, and no preference is a skip', () => {
  assert.equal(pickRecorderType((t) => t.startsWith('video/mp4')), 'video/mp4;codecs=avc1.42E01E,mp4a.40.2');
  assert.equal(pickRecorderType((t) => t === 'video/mp4'), 'video/mp4');
  assert.equal(pickRecorderType(() => false), null, 'webm-only engines leave the file alone');
  assert.equal(pickRecorderType(() => { throw new Error('no MediaRecorder'); }), null, 'a throwing probe is still "no"');
});

test('name: a file that is now mp4 must not still be called .MOV', () => {
  assert.equal(transcodedName('IMG_0432.MOV'), 'IMG_0432.mp4');
  assert.equal(transcodedName('../../weird name (1).mov'), 'weird_name_1.mp4',
    'path components never come back as dots');
  assert.equal(transcodedName('no-extension'), 'no-extension.mp4');
});

test('fallback: no MediaRecorder, no captureStream, no output — and never a lost clip', async () => {
  // the whole safety property of this file in one test: every engine that cannot
  // do the re-encode must end up sending the ORIGINAL file, not nothing, not a
  // silent. Headless Node is exactly such an engine, so the claim is checkable.
  const { transcodeVideo } = await import('../app/js/transcode.js');
  const fake = new Blob([new Uint8Array(64)], { type: 'video/quicktime' });
  fake.arrayBuffer = async () => new Uint8Array(64).buffer;
  assert.equal(await transcodeVideo(fake, { enabled: true }), null, 'no MediaRecorder in this environment');

  // with a recorder that cannot produce the target container, same answer
  globalThis.MediaRecorder = class { static isTypeSupported() { return false; } };
  globalThis.HTMLVideoElement = { prototype: { captureStream() { return {}; } } };
  assert.equal(await transcodeVideo(fake, { enabled: true }), null, 'webm-only engines leave the file alone');

  // and even with a recorder, no DOM means no element to decode with
  globalThis.MediaRecorder = class {
    static isTypeSupported() { return true; }
    constructor() { throw new Error('nope'); }
  };
  assert.equal(await transcodeVideo(fake, { enabled: true }), null, 'a throwing constructor is a fallback, not a failed send');
  delete globalThis.MediaRecorder; delete globalThis.HTMLVideoElement;
});

test('limits: the caps that protect a phone battery and the recipient', async () => {
  const { TRANSCODE_MAX_SECONDS } = await import('../app/js/transcode.js');
  assert.ok(TRANSCODE_MAX_SECONDS >= 30 && TRANSCODE_MAX_SECONDS <= 120,
    'real-time re-encoding is bounded to something a person will wait for');
});

test('cost: an already-playable clip never reaches a decoder', async () => {
  // the cheap pre-check is what keeps a normal Android upload free of a media
  // element, a decode and a battery cost — assert it by making any element
  // creation explode the test
  const { transcodeVideo } = await import('../app/js/transcode.js');
  const doc = dom.document;
  const realCreate = doc.createElement.bind(doc);
  const made = [];
  doc.createElement = (tag) => { made.push(String(tag).toLowerCase()); return realCreate(tag); };
  const mp4 = new Blob([new Uint8Array(0)], { type: 'video/mp4' });
  mp4.slice = () => ({ arrayBuffer: async () => ftypBytes('isom', 'avc1', 'mp41') });
  assert.equal(await transcodeVideo(mp4, { enabled: true }), null);
  assert.deepEqual(made, [], 'no <video>, no canvas: decided from the container alone');
  doc.createElement = realCreate;
});

function ftypBytes(major, ...compat) {
  const f = (s) => [...s].map((c) => c.charCodeAt(0));
  const body = [...f(major), ...compat.flatMap(f)];
  return new Uint8Array([0, 0, 0, 8 + body.length, ...f('ftyp'), ...body]);
}

// ---- which engine records, and the iPhone-shaped one ----
//
// The point of these is the platform that PRODUCES every .mov we care about:
// WebKit has no `HTMLMediaElement.captureStream()`, so an implementation built
// on it silently sent the original file — on exactly the device the feature was
// written for. The canvas engine is the answer, and headless Node can stand in
// for WebKit because the only thing that matters is which APIs are present.

function movBlob(size = 6000) {
  const bytes = new Uint8Array(size);
  bytes.set(ftypBytes('qt  ', 'moov'));
  return new Blob([bytes], { type: 'video/quicktime' });
}

/** A WebKit-shaped environment: element capture absent, canvas capture present,
 *  an MP4 recorder, and (by default) an audio graph that yields a track. */
function stubWebkit({ audio = true, sourceHasSound = true, webm = false, suspended = false } = {}) {
  const seen = { drawn: 0, attached: null, staged: false, contexts: [] };
  const realCreate = dom.document.createElement.bind(dom.document);
  const saved = {
    MR: globalThis.MediaRecorder, HVE: globalThis.HTMLVideoElement,
    HCE: globalThis.HTMLCanvasElement, AC: globalThis.AudioContext,
  };
  globalThis.MediaRecorder = class {
    static isTypeSupported = (t) => String(t).startsWith('video/mp4');
    start() { this.started = true; }
    stop() {
      const out = new Uint8Array(2000);
      out.set(webm ? new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]) : ftypBytes('isom', 'avc1', 'mp42'));
      this.ondataavailable?.({ data: new Blob([out], { type: webm ? 'video/webm' : 'video/mp4' }) });
      this.onstop?.();
    }
  };
  globalThis.HTMLVideoElement = { prototype: { requestVideoFrameCallback() {} } };  // NO captureStream
  globalThis.HTMLCanvasElement = { prototype: { captureStream() {} } };
  if (audio) {
    globalThis.AudioContext = class {
      constructor() { this.state = suspended ? 'suspended' : 'running'; seen.contexts.push(this); }
      resume() { return Promise.resolve(); }        // a phone that refuses to unsuspend
      createMediaElementSource() { return { connect() {} }; }
      createMediaStreamDestination() { return { stream: { getAudioTracks: () => [{ stop() {} }] } }; }
      close() { this.closed = true; }
    };
  } else delete globalThis.AudioContext;

  dom.document.createElement = (tag) => {
    const el = realCreate(tag);
    const t = String(tag).toLowerCase();
    if (t === 'video') {
      el.videoWidth = 1280; el.videoHeight = 720; el.duration = 2; el.readyState = 4;
      el.webkitAudioDecodedByteCount = sourceHasSound ? 4096 : 0;
      el.requestVideoFrameCallback = (cb) => { setTimeout(() => cb(), 0); return 1; };
      el.pause = () => { el.paused = true; };
      el.play = async () => {
        // the property that decides whether WebKit delivers frames at all
        seen.attached = el.parentNode === dom.document.body;
        el.paused = false;
        setTimeout(() => { el.ended = true; el.fire('ended'); }, 5);
      };
      Object.defineProperty(el, 'src', {
        configurable: true,
        get: () => el._src ?? '',
        set(v) { el._src = v; seen.staged = el.parentNode === dom.document.body; setTimeout(() => el.fire('loadedmetadata'), 0); },
      });
    }
    if (t === 'canvas') {
      el.getContext = () => ({ drawImage() { seen.drawn += 1; } });
      const tracks = [];
      el.captureStream = () => ({
        getVideoTracks: () => [{ stop() {} }],
        getAudioTracks: () => tracks,
        addTrack: (tr) => tracks.push(tr),
      });
    }
    return el;
  };
  return {
    seen,
    restore() {
      dom.document.createElement = realCreate;
      globalThis.MediaRecorder = saved.MR;
      globalThis.HTMLVideoElement = saved.HVE;
      globalThis.HTMLCanvasElement = saved.HCE;
      if (saved.AC === undefined) delete globalThis.AudioContext; else globalThis.AudioContext = saved.AC;
    },
  };
}

test('engine: the canvas records where the element cannot (WebKit)', async () => {
  const { captureSupport, captureEngine, transcodeVideo } = await import('../app/js/transcode.js');
  const stub = stubWebkit();
  try {
    const support = captureSupport();
    assert.equal(support.videoCapture, false, 'WebKit has no HTMLMediaElement.captureStream');
    assert.equal(support.canvasCapture, true);
    assert.deepEqual(captureEngine(support), { engine: 'canvas', why: 'canvas-capture' });
    const out = await transcodeVideo(movBlob(), { enabled: true });
    assert.ok(out instanceof Blob, 'a re-encoded clip came back instead of the .mov');
    assert.equal(out.type, 'video/mp4');
    assert.ok(out.size > 1024, 'and it is a real payload');
    assert.ok(stub.seen.drawn > 0, 'frames were painted into the canvas (that IS the encoder input)');
    assert.equal(stub.seen.attached, true,
      'the element was IN THE DOCUMENT while it played: a detached <video> yields no frames on WebKit');
  } finally { stub.restore(); }
});

test('engine: no capture API at all is a skip, never a lost clip', async () => {
  const { captureSupport, captureEngine } = await import('../app/js/transcode.js');
  assert.deepEqual(captureEngine({ recorder: false }), { engine: null, why: 'no-mediarecorder' });
  assert.deepEqual(captureEngine({ recorder: true, mp4Type: null }), { engine: null, why: 'no-mp4-recorder' });
  assert.deepEqual(captureEngine({ recorder: true, mp4Type: 'video/mp4' }), { engine: null, why: 'no-capture-engine' });
  assert.deepEqual(
    captureEngine({ recorder: true, mp4Type: 'video/mp4', videoCapture: true, canvasCapture: true }).engine,
    'element', 'one call, both tracks: the cheap engine wins where it exists');
  assert.equal(captureSupport({ globalThis: {} }).recorder, false, 'a bare environment supports nothing');
});

test('audio: a clip WITH a soundtrack is never re-encoded into a silent one', async () => {
  const { transcodeVideo } = await import('../app/js/transcode.js');
  const stub = stubWebkit({ audio: false, sourceHasSound: true });
  try {
    assert.equal(await transcodeVideo(movBlob(), { enabled: true }), null,
      'no audio graph + a source that has sound → send the original, sound and all');
  } finally { stub.restore(); }

  const quiet = stubWebkit({ audio: false, sourceHasSound: false });
  try {
    assert.ok(await transcodeVideo(movBlob(), { enabled: true }) instanceof Blob,
      'a silent source loses nothing, so the re-encode is still worth doing');
  } finally { quiet.restore(); }

  // a context that will not unsuspend records SILENCE: same answer, same reason
  const stuck = stubWebkit({ audio: true, sourceHasSound: true, suspended: true });
  try {
    assert.equal(await transcodeVideo(movBlob(), { enabled: true }), null,
      'a suspended audio graph must not produce a silent clip');
  } finally { stuck.restore(); }
});

test('output: a recorder that hands back WebM is not uploaded as .mp4', async () => {
  const { isPlayableMp4 } = await import('../app/js/transcode.js');
  assert.equal(isPlayableMp4(ftypBytes('isom', 'avc1', 'mp42')), true);
  assert.equal(isPlayableMp4(ftypBytes('qt  ', 'moov')), false, 'still QuickTime: not what we promised');
  assert.equal(isPlayableMp4(ftypBytes('hev1', 'hev1')), false, 'still HEVC: not what we promised');
  assert.equal(isPlayableMp4(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0])), false,
    'WebM out of a recorder that ignored the requested container');

  // …and end to end: such an output is thrown away, the ORIGINAL clip is sent
  const stub = stubWebkit({ webm: true });
  try {
    const { transcodeVideo } = await import('../app/js/transcode.js');
    assert.equal(await transcodeVideo(movBlob(), { enabled: true }), null, 'a wrong-container output is a skip, not a send');
  } finally { stub.restore(); }
});

test('journal: every outcome is sayable, including the skips', async () => {
  // the reason a phone kept sending .mov was invisible because the skip paths
  // only wrote to a console nobody was watching. Each one must reach the journal.
  const { transcodeVideo } = await import('../app/js/transcode.js');
  const lines = [];
  const stub = stubWebkit();
  try {
    await transcodeVideo(movBlob(), { enabled: true, log: (m) => lines.push(m) });
  } finally { stub.restore(); }
  assert.ok(lines.some((l) => /transcode: ok /.test(l)), `the success path reports itself: ${lines.join('|')}`);
  const quiet = stubWebkit({ audio: false, sourceHasSound: true });
  const skip = [];
  try {
    await transcodeVideo(movBlob(), { enabled: true, log: (m) => skip.push(m) });
  } finally { quiet.restore(); }
  assert.ok(skip.some((l) => /skipped \(source has audio, no audio capture\)/.test(l)),
    `the refusal says why: ${skip.join('|')}`);
});

test('audio: a context opened inside the gesture is the one used, and it is released', async () => {
  const { transcodeVideo, primeAudioContext } = await import('../app/js/transcode.js');
  const stub = stubWebkit();
  try {
    const ctx = primeAudioContext();
    assert.ok(ctx, 'this engine has Web Audio');
    assert.equal(ctx.state, 'running');
    const out = await transcodeVideo(movBlob(), { enabled: true, audioCtx: ctx });
    assert.ok(out instanceof Blob, 'the re-encode happened with the borrowed context');
    assert.deepEqual(stub.seen.contexts, [ctx], 'and it did NOT open a second one behind our back');
    assert.equal(ctx.closed, true, 'the borrowed context is closed, not leaked');
  } finally { stub.restore(); }
});
