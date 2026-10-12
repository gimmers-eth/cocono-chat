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
  assert.equal(await transcodeVideo(fake), null, 'no MediaRecorder in this environment');

  // with a recorder that cannot produce the target container, same answer
  globalThis.MediaRecorder = class { static isTypeSupported() { return false; } };
  globalThis.HTMLVideoElement = { prototype: { captureStream() { return {}; } } };
  assert.equal(await transcodeVideo(fake), null, 'webm-only engines leave the file alone');

  // and even with a recorder, no DOM means no element to decode with
  globalThis.MediaRecorder = class {
    static isTypeSupported() { return true; }
    constructor() { throw new Error('nope'); }
  };
  assert.equal(await transcodeVideo(fake), null, 'a throwing constructor is a fallback, not a failed send');
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
  assert.equal(await transcodeVideo(mp4), null);
  assert.deepEqual(made, [], 'no <video>, no canvas: decided from the container alone');
  doc.createElement = realCreate;
});

function ftypBytes(major, ...compat) {
  const f = (s) => [...s].map((c) => c.charCodeAt(0));
  const body = [...f(major), ...compat.flatMap(f)];
  return new Uint8Array([0, 0, 0, 8 + body.length, ...f('ftyp'), ...body]);
}
