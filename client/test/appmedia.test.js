// The app's media module: every rule that can be decided without a browser.
// The canvas/video plumbing needs a DOM and gets smoked by hand; the POLICY
// (what is refused, what auto-downloads, what is blurred, what gets pruned,
// which rows a tab shows) is pure and is asserted here — it is exactly the
// kind of thing that silently rots when a bubble renderer changes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectKind, isAnimatedMime, sanitizeName, assertWithinLimits, MediaReject,
  formatSize, durationText, mediaLabel, parseMediaPayload, mediaRow, blobOf,
  autoDownload, autoDownloadThumb, isBlurred, pruneDue, prunePatch,
  extractLinks, tabBuckets, filterMedia, MEDIA_MAX_BYTES, LOCAL_RETENTION_DAYS_DEFAULT,
} from '../app/js/media.js';

const M = await import('../app/js/media.js');

test('media: the RENDER guard backs the picker guard (an svg never becomes an <img>)', () => {
  assert.equal(M.renderableAsImage({ kind: 'image', mime: 'image/jpeg' }), true);
  assert.equal(M.renderableAsImage({ kind: 'image', mime: 'image/svg+xml' }), false);
  assert.equal(M.renderableAsImage({ kind: 'image', mime: 'IMAGE/SVG' }), false, 'case is not a way through');
  assert.equal(M.renderableAsImage({ kind: 'video', mime: 'video/mp4' }), false, 'a video is not an image');
  assert.equal(M.renderableAsImage(null), false);
});

test('media: kind detection — svg is refused outright, everything else maps', () => {
  assert.equal(detectKind('image/jpeg'), 'image');
  assert.equal(detectKind('IMAGE/PNG'), 'image');
  assert.equal(detectKind('video/mp4'), 'video');
  assert.equal(detectKind('application/pdf'), 'file');
  assert.equal(detectKind(''), 'file');
  // the one format our origin must never render, however it arrives
  assert.throws(() => detectKind('image/svg+xml'), MediaReject);
  assert.throws(() => detectKind('image/SVG'), MediaReject);
  assert.match(detectKind.name, /^detectKind$/);
});

test('media: animated formats are flagged (canvas would kill the motion)', () => {
  assert.equal(isAnimatedMime('image/gif'), true);
  assert.equal(isAnimatedMime('image/webp'), true);
  assert.equal(isAnimatedMime('image/jpeg'), false);
});

test('media: names are untrusted display text from the sender', () => {
  assert.equal(sanitizeName('C:\\Users\\me\\Pictures\\holiday.jpg'), 'holiday.jpg');
  assert.equal(sanitizeName('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeName('  two   spaces  '), 'two spaces');
  assert.equal(sanitizeName('').startsWith('attachment-'), true);
  assert.equal(sanitizeName('x'.repeat(400)).length, 120);
  // a name that looks like markup stays harmless: it is only ever assigned
  // through textContent — and sanitising must not strip it into nothing
  assert.equal(sanitizeName('<img onerror=alert(1)>.png'), '<img onerror=alert(1)>.png');
});

test('media: the size gate says no in the units the user thinks in', () => {
  assert.equal(assertWithinLimits('file', 10), undefined);
  assert.throws(() => assertWithinLimits('file', MEDIA_MAX_BYTES + 1), (err) => {
    assert.ok(err instanceof MediaReject);
    assert.match(err.message, /10\.0 MB/);
    return true;
  });
  assert.throws(() => assertWithinLimits('image', 0), /empty/);
  assert.equal(formatSize(512), '512 B');
  assert.equal(formatSize(2048), '2.0 KB');
  assert.equal(formatSize(MEDIA_MAX_BYTES), '10.0 MB');
  assert.equal(durationText(75.4), '1:15');
});

test('media: the payload parser is as defensive as the sys path', () => {
  const good = '{"media":{"id":"abc12345","kind":"image","key":"k","name":"a.jpg"}}';
  assert.equal(parseMediaPayload(good).id, 'abc12345');
  // unparsable / shapeless / plain text: NOT media, never a crash
  assert.equal(parseMediaPayload('{"media":'), null);
  assert.equal(parseMediaPayload('{"media":{"kind":"image"}}'), null, 'no id/key is not a media message');
  assert.equal(parseMediaPayload('hello'), null);
  assert.equal(parseMediaPayload('{"sys":"friend+","ul":"bob"}'), null);
  assert.equal(parseMediaPayload(null), null);
  assert.equal(mediaLabel('image'), 'Photo');
  assert.equal(mediaLabel('video'), 'Video');
  assert.equal(mediaLabel('file', 'spec.pdf'), 'File: spec.pdf');
});

test('media: rows carry the blob pointer separately from the local key', () => {
  // INCOMING: the row IS the blob
  const inRow = mediaRow({
    key: 'blob-1', peer: 'Bobby', dir: 'in', kind: 'image',
    media: { id: 'blob-1', name: 'x.jpg', mime: 'image/jpeg', size: 12, key: 'k', iv: 'i', sha256: 's' },
    msgId: 'in:m1', ts: 1000,
  });
  assert.equal(inRow.id, 'blob-1');
  assert.equal(blobOf(inRow), 'blob-1');
  assert.equal(inRow.peer, 'bobby', 'peers are stored lowercase, like every other store');
  assert.equal(inRow.state, 'pending');
  assert.equal(inRow.keep, false);
  assert.equal(inRow.blurred, null, 'null = no override, use the verified-flag default');
  assert.equal(inRow.data, null);

  // OUTGOING: written before the upload answers, so there is no blob yet
  const outRow = mediaRow({ key: 'out:abc', blobId: null, peer: 'bobby', dir: 'out', kind: 'file', media: { name: 'n' }, msgId: 'out:abc', ts: 1 });
  assert.equal(blobOf(outRow), null, 'nothing to download until the upload lands');
  assert.equal(outRow.size, 0);
});

test('media: arrival policy — images by themselves, videos a poster only, files never', () => {
  assert.equal(autoDownload('image'), true);
  assert.equal(autoDownload('video'), false);
  assert.equal(autoDownload('file'), false);
  assert.equal(autoDownloadThumb('image'), true);
  assert.equal(autoDownloadThumb('video'), true, 'a video auto-downloads its POSTER and nothing else');
  assert.equal(autoDownloadThumb('file'), false);
});

test('media: blur policy (req 7) — display only, sender-verified clears it', () => {
  const recv = { dir: 'in', kind: 'image' };
  assert.equal(isBlurred(recv, false), true, 'unverified sender → blurred');
  assert.equal(isBlurred(recv, undefined), true, 'unknown is treated as unverified');
  assert.equal(isBlurred(recv, true), false, 'identity-verified sender → clear');
  assert.equal(isBlurred({ ...recv, blurred: false }, false), false, 'an explicit unblur wins');
  assert.equal(isBlurred({ ...recv, blurred: true }, true), true, 'and so does an explicit blur');
  // req 7 is about RECEIVED images: my own sends are never hidden from me
  assert.equal(isBlurred({ dir: 'out', kind: 'image' }, false), false);
});

test('media: local pruning drops bytes, keeps records, honours Keep', () => {
  const day = 86_400_000;
  const now = 10 * day;
  const rows = [
    { id: 'old', state: 'stored', ts: now - 30 * day, kind: 'image', keep: false, data: 1, thumb: 1 },
    { id: 'pinned', state: 'stored', ts: now - 30 * day, kind: 'file', keep: true, data: 1 },
    { id: 'recent', state: 'stored', ts: now - day, kind: 'image', keep: false, data: 1 },
    { id: 'pending', state: 'pending', ts: now - 30 * day, kind: 'file', data: null },
    { id: 'declined', state: 'declined', ts: now - 30 * day, kind: 'file', data: null },
  ];
  const due = pruneDue(rows, { now, days: 7 });
  assert.deepEqual(due.map((r) => r.id), ['old'], 'only stored, unpinned, out-of-window records');
  const patch = prunePatch(rows[0]);
  assert.equal(patch.data, null, 'the bytes go');
  assert.ok(patch.thumb, 'an image keeps its thumbnail (the wall still shows it)');
  assert.equal(patch.state, 'pruned');
  const filePatch = prunePatch({ id: 'f', kind: 'file', thumb: 1 });
  assert.equal(filePatch.thumb, null, 'a file has no preview to keep');
  assert.equal(pruneDue(rows, { now, days: LOCAL_RETENTION_DAYS_DEFAULT }).length, 1);
});

test('media: the retention window is measured from when the bytes ARRIVED', () => {
  const day = 86_400_000;
  const now = 40 * day;
  const rows = [
    // a photo in a three-week-old chat, downloaded yesterday: the message is
    // old, the bytes are not — dropping them would delete what the user just
    // waited for, which is the bug this guards
    { id: 'fresh-download', state: 'stored', ts: now - 21 * day, storedAt: now - day, keep: false },
    // the same thing pulled three weeks ago: now it is due
    { id: 'stale-download', state: 'stored', ts: now - 21 * day, storedAt: now - 20 * day, keep: false },
    // a sender's own copy (written when the bytes were made, no storedAt yet):
    // falls back to the message time, and it is due
    { id: 'own-old-copy', state: 'stored', ts: now - 21 * day, keep: false },
  ];
  assert.deepEqual(M.pruneDue(rows, { now, days: 7 }).map((r) => r.id),
    ['stale-download', 'own-old-copy']);
});

test('media: links are pulled out of the transcript client-side', () => {
  const links = extractLinks('see https://co.co.no/x?a=1, and http://example.com/y. also https://co.co.no/x?a=1 again');
  assert.deepEqual(links.map((l) => l.url), ['https://co.co.no/x?a=1', 'http://example.com/y'],
    'an exact repeat is de-duped; a different scheme is a different URL');
  assert.deepEqual(links.map((l) => l.host), ['co.co.no', 'example.com']);
  // trailing prose punctuation is not part of the URL
  assert.equal(extractLinks('nice https://example.com/a)!').length, 1);
  assert.equal(extractLinks('https://example.com/a)')[0].url, 'https://example.com/a');
  assert.deepEqual(extractLinks('no urls here'), []);
  assert.deepEqual(extractLinks('javascript:alert(1)'), [], 'only http(s) is a link');
  assert.deepEqual(extractLinks('https://'), []);
});

test('media: the tabs read the transcript, and only files-tab means files', () => {
  const msgs = [
    { id: 'in:1', peer: 'bobby', dir: 'in', ts: 1, kind: 'image', mediaId: 'b1', text: 'Photo' },
    { id: 'in:2', peer: 'bobby', dir: 'in', ts: 2, kind: 'video', mediaId: 'b2', text: 'Video' },
    { id: 'out:3', peer: 'bobby', dir: 'out', ts: 3, kind: 'file', mediaId: 'b3', text: 'File: x' },
    { id: 'in:4', peer: 'bobby', dir: 'in', ts: 4, text: 'look at https://example.com/a' },
    { id: 'sys:5', peer: 'bobby', dir: 'sys', ts: 5, text: 'a notice with https://example.com/b' },
  ];
  const rows = [
    { id: 'b1', kind: 'image', dir: 'in', ts: 1, name: 'a.jpg' },
    { id: 'b2', kind: 'video', dir: 'in', ts: 2, name: 'b.mp4' },
    { id: 'b3', kind: 'file', dir: 'out', ts: 3, name: 'c.pdf' },
  ];
  const t = tabBuckets(msgs, rows);
  assert.deepEqual(t.images.map((r) => r.id), ['b1']);
  assert.deepEqual(t.videos.map((r) => r.id), ['b2']);
  assert.deepEqual(t.files.map((r) => r.id), ['b3'], 'a video is not a file');
  assert.deepEqual(t.links.map((l) => l.url), ['https://example.com/a'], 'notices carry no links');
  // newest first, like a chat
  const many = tabBuckets(
    [{ id: 'm1', kind: 'image', mediaId: 'x1', ts: 1, dir: 'in' }, { id: 'm2', kind: 'image', mediaId: 'x2', ts: 9, dir: 'out' }],
    [{ id: 'x1', kind: 'image', ts: 1 }, { id: 'x2', kind: 'image', ts: 9 }],
  );
  assert.deepEqual(many.images.map((r) => r.id), ['x2', 'x1']);
  // a media message whose row is gone (never downloaded here) simply does not
  // appear — no ghost tile, no crash
  assert.deepEqual(tabBuckets([{ id: 'm', kind: 'image', mediaId: 'zz', ts: 1 }], []).images, []);
  assert.deepEqual(filterMedia(rows, 'PDF').map((r) => r.id), ['b3'], 'search is case-insensitive');
  assert.deepEqual(filterMedia(rows, '  ').map((r) => r.id), ['b1', 'b2', 'b3'], 'blank query is no filter');
  assert.deepEqual(filterMedia(rows, 'nothing'), []);
});

test('media: a saved FILE gets a name an OS can open (and bytes to open)', () => {
  // the name arrives from the SENDER, so this is untrusted input on its way to
  // a filesystem: path parts and hostile characters go, an extension is
  // guaranteed — 'IMG_0142' without .jpg opens in nothing
  assert.equal(M.deviceFileName({ name: 'report.pdf', mime: 'application/pdf' }), 'report.pdf');
  assert.equal(M.deviceFileName({ name: 'IMG_0142', mime: 'image/jpeg', kind: 'image' }), 'IMG_0142.jpg');
  assert.equal(M.deviceFileName({ name: '', mime: 'video/mp4', kind: 'video' }), 'video.mp4');
  const nasty = M.deviceFileName({ name: '../../x:c<u>z?.mp4', mime: 'video/mp4', kind: 'video' });
  assert.ok(!/[\\/:*?"<>|]/.test(nasty), `forbidden characters stripped: ${nasty}`);
  assert.ok(nasty.endsWith('.mp4'), 'the extension survives the scrub');
  assert.ok(M.deviceFileName({ name: 'x'.repeat(400), mime: 'text/plain' }).length <= 180);

  assert.equal(M.hasLocalBytes({ data: new Blob(['x']) }), true);
  assert.equal(M.hasLocalBytes({ data: null }), false);
  assert.equal(M.hasLocalBytes({ data: new Blob([]) }), false, 'an empty file is not a thing to save');
});
