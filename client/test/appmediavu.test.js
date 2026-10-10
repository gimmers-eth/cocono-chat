// The app's media UI, EXECUTED: bubble painting, the conversation tabs and the
// viewer's control row run here against a small DOM stand-in + the IndexedDB
// shim, so "the blur toggle persists" is a test and not a manual-smoke line.
//
// Why this file exists: the static guards (graph.test.js parses, mediaui.test.js
// checks ids/imports) cannot prove behaviour, and there is no browser in the
// test environment. Everything asserted below is the part a reviewer would
// otherwise have to click through on a phone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { installIdbShim } from './idbshim.js';
import { installDomShim } from './domshim.js';

const shim = installIdbShim();
const APP = path.resolve(import.meta.dirname, '..', 'app');
const dom = installDomShim(readFileSync(path.join(APP, 'index.html'), 'utf8'));

const store = await import('../app/js/store.js');
const M = await import('../app/js/media.js');
const { bubbleNodes } = await import('../app/js/components/mediabubble.js');
const view = await import('../app/js/components/mediaview.js');

let n = 0;
async function fresh(peer = 'bobby') {
  shim.reset();
  dom.reset();
  store.setScope(`u${++n}`);
  return peer;
}

/** A media row, with the kind/name/size of the descriptor the wire carries. */
const row = (over = {}) => {
  const kind = over.kind ?? 'image';
  const base = M.mediaRow({
    key: over.id ?? 'blob-1',
    peer: 'bobby', dir: over.dir ?? 'in', kind,
    media: {
      id: over.id ?? 'blob-1', kind, name: over.name ?? `a.${kind === 'video' ? 'mp4' : kind === 'file' ? 'pdf' : 'jpg'}`,
      mime: over.mime ?? (kind === 'video' ? 'video/mp4' : kind === 'file' ? 'application/pdf' : 'image/jpeg'),
      size: over.size ?? 2048, key: 'k', iv: 'i', ...(kind === 'file' ? {} : { thumbIv: 't' }), sha256: 's',
    },
    msgId: over.msgId ?? 'in:m1', ts: over.ts ?? Date.now(),
  });
  return { ...base, ...over };
};

const stored = async (over = {}) => {
  const r = row({ state: 'stored', ...over });
  r.state = 'stored';
  r.thumb = over.thumb === undefined ? new Blob(['T']) : over.thumb;
  r.data = over.data === undefined ? new Blob(['FULLBYTES']) : over.data;
  await store.saveMedia(r);
  return r;
};

const classesOf = (nodes) => nodes.flatMap((node) => {
  const list = [];
  const walk = (el) => {
    if (el?.className) list.push(el.className);
    (el?.childNodes ?? []).forEach(walk);
  };
  walk(node);
  return list;
});

const has = (nodes, re) => classesOf(nodes).some((c) => re.test(c));

// ---------------- bubbles ----------------

test('bubble: an unverified sender\'s photo is blurred, a verified one is not', async () => {
  await fresh();
  const img = await stored({ state: 'stored' });
  const blurred = bubbleNodes({ dir: 'in', kind: 'image', state: 'delivered' }, img, { verified: false });
  assert.ok(has(blurred, /media-thumb/), 'the bubble paints the preview');
  assert.ok(has(blurred, /is-blurred/), 'req 7: unverified sender → blurred by default');

  const clear = bubbleNodes({ dir: 'in', kind: 'image', state: 'delivered' }, img, { verified: true });
  assert.ok(!has(clear, /is-blurred/), 'identity-verified sender → shown');
});

test('bubble: my own sends are never blurred, and a stored image never says "download"', async () => {
  await fresh();
  const mine = await stored({ dir: 'out', state: 'stored' });
  const nodes = bubbleNodes({ dir: 'out', kind: 'image', state: 'sent' }, mine, { verified: false });
  assert.ok(!has(nodes, /is-blurred/), 'req 7 applies to RECEIVED images');
  assert.ok(!has(nodes, /media-dl/), 'a stored image has nothing to download');
});

test('bubble: a pending file carries BOTH choices, a video only Download', async () => {
  await fresh();
  const file = row({ id: 'f1', kind: 'file' });
  file.state = 'pending';
  const fileNodes = bubbleNodes({ dir: 'in', kind: 'file', state: 'delivered' }, file, {});
  assert.ok(has(fileNodes, /media-file-name/), 'name is shown (as textContent, never markup)');
  assert.ok(has(fileNodes, /media-dl/), 'Download (req 6)');
  assert.ok(has(fileNodes, /media-decline/), 'Delete-before-download (req 6)');

  const video = row({ id: 'v1', kind: 'video', dur: 42 });
  video.state = 'pending';
  video.thumb = new Blob(['T']);
  const vNodes = bubbleNodes({ dir: 'in', kind: 'video', state: 'delivered' }, video, {});
  assert.ok(has(vNodes, /media-play-badge/), 'the poster gets a play badge');
  assert.ok(has(vNodes, /media-duration/), 'and a duration chip');
  assert.ok(has(vNodes, /media-dl/));
  assert.ok(!has(vNodes, /media-decline/), 'a video is not deletable-before-download (it already pulled its poster)');
});

test('bubble: expired, pruned and in-flight states say what they mean', async () => {
  await fresh();
  const expired = row(); expired.state = 'expired';
  const expiredNodes = bubbleNodes({ dir: 'in', kind: 'image' }, expired, {});
  assert.match(expiredNodes.map((x) => x.textContent).join(' '), /No longer available/);
  assert.ok(classesOf(expiredNodes).some((c) => /fa-circle-question/.test(c)),
    'the gone glyph, not a photo glyph: mediaExpired is what that state looks like');
  assert.ok(!has(bubbleNodes({ dir: 'in', kind: 'image' }, expired, {}), /media-dl/), 'an expired blob cannot be retried');

  const pruned = await stored({ id: 'p1' });
  await store.updateMedia('p1', M.prunePatch(pruned));
  const again = await store.getMedia('p1');
  const nodes = bubbleNodes({ dir: 'in', kind: 'image' }, again, {});
  assert.match(nodes.map((x) => x.textContent).join(' '), /Removed from this device/);
  assert.ok(has(nodes, /media-thumb/), 'the preview stays — only the bytes aged out');

  // an in-flight SEND says Uploading (the bytes are still leaving); a send the
  // server already accepted but this device has no row for says so plainly
  assert.match(bubbleNodes({ dir: 'out', kind: 'image', state: 'sending' }, null, {}).map((x) => x.textContent).join(' '), /Uploading/);
  assert.match(bubbleNodes({ dir: 'out', kind: 'image', state: 'sent' }, null, {}).map((x) => x.textContent).join(' '), /Not on this device/);
});

test('bubble: an "image" that turns out to be SVG is never painted as a picture', async () => {
  await fresh();
  // a MODIFIED sender can claim kind image with svg bytes; the picker refuses
  // SVG on OUR side, so this is the receive-side rule (security checklist)
  const svg = row({ id: 'svg1', kind: 'image', mime: 'image/svg+xml', name: 'card.svg' });
  svg.state = 'stored';
  svg.data = new Blob(['<svg onload="alert(1)"><circle /></svg>']);
  svg.thumb = svg.data;
  await store.saveMedia(svg);
  const nodes = bubbleNodes({ dir: 'in', kind: 'image', state: 'delivered' }, svg, { verified: true });
  assert.ok(!has(nodes, /media-thumb/), 'no <img> for a Blob URL that could carry script');
  assert.ok(has(nodes, /media-file-name/), 'it degrades to a file row: a name, a size, a download');

  // and the viewer agrees with the bubble
  const host = dom.byId('msg-media');
  view.openViewer(host, {
    client: fakeClient(), msg: { dir: 'in', kind: 'image' }, row: svg,
    verified: true, onChange: () => {}, onStatus: () => {},
  });
  assert.equal(host.querySelector('.viewer-image'), null, 'the viewer never mounts an SVG image element');
  assert.ok(host.querySelector('.viewer-file'), 'the viewer shows the file card instead');
});

// ---------------- tabs ----------------

test('tabs: the strip is five icons and switching is a callback, not a location', async () => {
  await fresh();
  const strip = dom.byId('chat-tabs');
  const seen = [];
  view.buildTabStrip(strip, { onChange: (t) => seen.push(t) });
  assert.equal(strip.children.length, 5);
  assert.deepEqual(strip.children.map((c) => c.dataset.tab), view.TABS);
  strip.children[2].click();
  assert.deepEqual(seen, ['videos']);
  view.paintTabActive(strip, 'videos');
  assert.ok(strip.children[2].className.includes('active'));
  assert.ok(!strip.children[0].className.includes('active'));
});

test('tabs: the image wall marks sent vs received by BORDER CLASS, links open safely', async () => {
  await fresh();
  await stored({ id: 'in1', ts: 2000 });
  await stored({ id: 'out1', dir: 'out', ts: 1000 });
  await store.saveMessage({ id: 'in:1', peer: 'bobby', dir: 'in', kind: 'image', mediaId: 'in1', ts: 2, text: 'Photo' });
  await store.saveMessage({ id: 'out:1', peer: 'bobby', dir: 'out', kind: 'image', mediaId: 'out1', ts: 1, text: 'Photo' });
  await store.saveMessage({ id: 'in:2', peer: 'bobby', dir: 'in', ts: 3, text: 'read https://example.com/doc?a=1 now' });
  await store.saveMessage({ id: 'sys:1', peer: 'bobby', dir: 'sys', ts: 4, text: 'notice https://evil.example' });

  const panel = dom.byId('chat-tabpanel');
  const opened = [];
  await view.paintTabPanel(panel, { peer: 'bobby', tab: 'images', verified: true, onOpen: (r) => opened.push(r.id) });
  const tiles = panel.querySelectorAll('.media-tile');
  assert.equal(tiles.length, 2);
  const sent = tiles.find((t) => t.className.includes('media-sent'));
  const recv = tiles.find((t) => t.className.includes('media-recv'));
  assert.ok(sent, 'sent = accent border');
  assert.ok(recv, 'received = neutral border');
  assert.ok(tiles.indexOf(recv) < tiles.indexOf(sent), 'newest first (the wall is a timeline)');
  recv.click();
  assert.deepEqual(opened, ['in1'], 'a tile opens the viewer for ITS record');

  await view.paintTabPanel(panel, { peer: 'bobby', tab: 'links', onOpen: () => {} });
  const links = panel.querySelectorAll('.link-line');
  assert.equal(links.length, 1, 'notices carry no links (only real messages do)');
  assert.equal(links[0].getAttribute('href') ?? links[0].href, 'https://example.com/doc?a=1');
  assert.equal(links[0].target, '_blank');
  assert.equal(links[0].rel, 'noopener noreferrer', 'a media-chat link never hands the opener to the target');
});

test('tabs: the files list is searchable and keeps its caret while typing', async () => {
  await fresh();
  const mk = async (id, name) => {
    const r = row({ id, kind: 'file' });
    r.kind = 'file'; r.name = name; r.state = 'stored';
    await store.saveMedia(r);
    await store.saveMessage({ id: `in:${id}`, peer: 'bobby', dir: 'in', kind: 'file', mediaId: id, ts: 1, text: `File: ${name}` });
  };
  await mk('a', 'invoice.pdf');
  await mk('b', 'holiday.png');

  const panel = dom.byId('chat-tabpanel');
  await view.paintTabPanel(panel, { peer: 'bobby', tab: 'files', query: '', onOpen: () => {}, onAction: () => {} });
  const input = panel.querySelector('.media-search').querySelector('input');
  assert.equal(panel.querySelectorAll('.media-line').length, 2);

  input.value = 'invo';
  input.fire('input');
  const rows = panel.querySelectorAll('.media-line');
  assert.equal(rows.length, 1, 'the search filters by name (req 4)');
  assert.ok(rows[0].textContent.includes('invoice.pdf'));
  assert.equal(panel.querySelector('input'), input, 'the input node SURVIVES the filter (a rebuild would drop the caret)');
});

// ---------------- the viewer ----------------

test('viewer: blur and Keep are user choices that PERSIST, and the download button works', async () => {
  await fresh();
  const img = await stored({ id: 'vBlur' });
  await store.saveMessage({ id: 'in:v', peer: 'bobby', dir: 'in', kind: 'image', mediaId: 'vBlur', ts: 1, text: 'Photo' });
  const host = dom.byId('msg-media');
  const changed = [];
  const teardown = view.openViewer(host, {
    client: fakeClient(),
    msg: { dir: 'in', kind: 'image' },
    row: img,
    verified: false,
    onChange: (r) => changed.push(r),
    onStatus: () => {},
  });

  assert.ok(host.querySelector('.viewer-image'), 'the full-size picture is shown');
  assert.ok(host.querySelector('.viewer-image').className.includes('is-blurred'), 'blurred on open (unverified sender)');

  const blurBtn = host.querySelectorAll('.viewer-toggle')[0];
  blurBtn.click();
  await settle();
  assert.equal((await store.getMedia('vBlur')).blurred, false, 'the toggle writes the override');
  assert.deepEqual(changed.map((r) => r.blurred), [false]);

  const keepBtn = host.querySelectorAll('.viewer-toggle').find((b) => /Keep/i.test(b.textContent));
  keepBtn.click();
  await settle();
  assert.equal((await store.getMedia('vBlur')).keep, true, 'Keep pins against the local prune (§4.5)');
  teardown();
  assert.equal(host.children.length, 0, 'closing empties the pane');
});

test('viewer: a not-yet-downloaded file offers ONE honest action — Download', async () => {
  await fresh();
  const pending = row({ id: 'vDl', kind: 'file' });
  pending.state = 'pending'; pending.data = null; pending.thumb = null;
  await store.saveMedia(pending);
  const cli = fakeClient();
  const host = dom.byId('msg-media');
  const changed = [];
  const teardown = view.openViewer(host, {
    client: cli, msg: { dir: 'in', kind: 'file' }, row: pending,
    verified: true, onChange: (r) => changed.push(r), onStatus: () => {},
  });
  const dl = host.querySelectorAll('.viewer-toggle').find((b) => /Download/i.test(b.textContent));
  assert.ok(dl, 'req 6: download from the viewer too');
  dl.click();
  await settle();
  assert.deepEqual(cli.calls.map((c) => c.what), ['download', 'ack'], 'download then ack (req 8)');
  assert.equal((await store.getMedia('vDl')).state, 'stored');
  assert.deepEqual(changed.map((r) => r.state), ['stored'], 'the caller is told so the chat repaints');
  teardown();
});

test('viewer: animated images get a real pause (the poster), videos get play + mute', async () => {
  await fresh();
  const gif = await stored({ id: 'vGif', animated: true });
  const host = dom.byId('msg-media');
  const teardown = view.openViewer(host, {
    client: fakeClient(), msg: { dir: 'in', kind: 'image' }, row: gif,
    verified: true, onChange: () => {}, onStatus: () => {},
  });
  const img = host.querySelector('.viewer-image');
  const pause = host.querySelectorAll('.viewer-toggle').find((b) => /Pause/i.test(b.textContent));
  assert.ok(pause, 'req 3: play/pause for animations');
  const animatedSrc = img.src;
  pause.click();
  assert.notEqual(img.src, animatedSrc, 'pause swaps to a STILL (an <img> GIF cannot be paused)');
  pause.click();
  assert.equal(img.src, animatedSrc, 'and swaps back');
  teardown();

  const vid = await stored({ id: 'vVid', kind: 'video' });
  const host2 = dom.byId('msg-media');
  const teardown2 = view.openViewer(host2, {
    client: fakeClient(), msg: { dir: 'in', kind: 'video' }, row: vid,
    verified: true, onChange: () => {}, onStatus: () => {},
  });
  const video = host2.querySelector('.viewer-video');
  assert.equal(video.playsInline, true);
  assert.equal(video.controls, undefined, 'no native controls: the app row owns them');
  assert.equal(video.muted, true, 'a video that starts with sound is a hostile default');
  const toggles = host2.querySelectorAll('.viewer-toggle');
  toggles.find((b) => /Play/i.test(b.textContent)).click();
  assert.equal(video.paused, false);
  toggles.find((b) => /Unmute|Mute/i.test(b.textContent)).click();
  assert.equal(video.muted, false);
  teardown2();
});

test('viewer: an expired blob is explained, and the button cannot lie', async () => {
  await fresh();
  const gone = row({ id: 'vGone' });
  gone.state = 'expired'; gone.data = null; gone.thumb = null;
  await store.saveMedia(gone);
  const host = dom.byId('msg-media');
  view.openViewer(host, {
    client: fakeClient(), msg: { dir: 'in', kind: 'image' }, row: gone,
    verified: true, onChange: () => {}, onStatus: () => {},
  });
  const dl = host.querySelectorAll('.viewer-toggle').find((b) => /Download/i.test(b.textContent));
  assert.equal(dl.disabled, true, 'no button that can only fail');
  assert.match(host.textContent, /no longer available/i);
});

// ---------------- object URL scopes ----------------

test('urls: a re-render releases bubble URLs and never touches the open viewer', async () => {
  await fresh();
  const img = await stored({ id: 'scope1' });
  const bubble = bubbleNodes({ dir: 'in', kind: 'image' }, img, { verified: true });
  const bubbleUrl = bubble[0].querySelector('img').src;
  const host = dom.byId('msg-media');
  const teardown = view.openViewer(host, {
    client: fakeClient(), msg: { dir: 'in', kind: 'image' }, row: img, verified: true, onChange: () => {}, onStatus: () => {},
  });
  const viewerUrl = host.querySelector('.viewer-image').src;
  assert.notEqual(bubbleUrl, viewerUrl, 'two surfaces, two URLs (different scopes)');

  M.releaseScope('bubbles');          // what render() does before each paint
  assert.ok(dom.revoked.includes(bubbleUrl), 'the bubble URL is released, not leaked');
  assert.ok(!dom.revoked.includes(viewerUrl), 'the viewer keeps its picture — this is the blanking bug');
  teardown();
  assert.ok(dom.revoked.includes(viewerUrl), 'closing releases it');
});

// The viewer's buttons are fire-and-forget (they report through onStatus and
// onChange, never by returning a promise), so a test that clicks one has to let
// the work drain. MACROTASK turns, not microtasks: the IDB shim settles its
// requests on a timer, exactly like real IndexedDB does.
const settle = async (turns = 25) => {
  for (let i = 0; i < turns; i++) await new Promise((r) => setTimeout(r, 0));
};

// ---------------- a stub client for the viewer's actions ----------------

function fakeClient() {
  const cli = { calls: [], _pending: [] };
  cli.downloadMedia = async (id, media) => {
    cli.calls.push({ what: 'download', id, media });
    cli._pending.push(Promise.resolve());
    return { data: new Blob(['downloaded']), thumb: new Blob(['T']) };
  };
  cli.downloadThumb = async (id) => { cli.calls.push({ what: 'thumb', id }); return new Blob(['T']); };
  cli.ackMedia = async (id, downloaded) => { cli.calls.push({ what: 'ack', id, downloaded }); return { ok: true }; };
  return cli;
}

// ---------------- getting the bytes OUT to the device ----------------

/** Node has a read-only `navigator` global; the save path only needs the two
 *  share methods, so replace the whole object for the duration of a test. */
function setNavigator(value) {
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });
}

test('save: the share sheet is the door when the browser can use it', async () => {
  await fresh();
  const shared = [];
  setNavigator({
    canShare: (data) => !!(data?.files?.length),
    share: async (data) => { shared.push(data); },
  });
  const row = await stored({ id: 'sv1', kind: 'file', name: 'invoice.pdf', mime: 'application/pdf' });
  const res = await M.saveToDevice(row);
  assert.equal(res.ok, true);
  assert.equal(res.how, 'shared', 'iOS/Android: "Save to Files" or another app lives here');
  assert.equal(shared[0].files[0].name, 'invoice.pdf', 'the FILE carries the name the user sees');
  assert.equal(shared[0].files[0].type, 'application/pdf');
  assert.equal(shared[0].title, 'invoice.pdf');
  setNavigator({ onLine: true, userAgent: 'node' });
});

test('save: no share support → a same-origin download anchor with the right filename', async () => {
  await fresh();
  setNavigator({ onLine: true });     // no share/canShare at all (desktop Firefox)
  const row = await stored({ id: 'sv2', kind: 'video', name: 'clip', mime: 'video/mp4' });
  const before = dom.created.length;
  const res = await M.saveToDevice(row);
  assert.equal(res.how, 'saved', res.how);
  const anchor = dom.created.slice(before).find((el) => el.tagName === 'A');
  assert.ok(anchor, 'a <a download> is the fallback door');
  assert.equal(anchor.download, 'clip.mp4', 'and it carries the extension the OS needs');
  assert.match(anchor.href, /^blob:local\//);
  assert.equal(anchor.parentNode, null, 'removed again — no stray node in the body');
  setNavigator({ onLine: true, userAgent: 'node' });
});

test('save: a dismissed sheet is not an error, and missing bytes are not a save', async () => {
  await fresh();
  setNavigator({
    canShare: () => true,
    share: async () => { const e = new Error('dismissed'); e.name = 'AbortError'; throw e; },
  });
  const withBytes = await stored({ id: 'sv3' });
  assert.deepEqual((await M.saveToDevice(withBytes)).how, 'cancelled',
    'the user closing the share sheet must not be reported as a failure');

  setNavigator({ canShare: () => true, share: async () => {} });
  const nothing = { ...row({ id: 'sv4' }), data: null };
  const res = await M.saveToDevice(nothing);
  assert.equal(res.ok, false);
  assert.equal(res.how, 'none', 'nothing to hand over: no share sheet, no anchor');
  setNavigator({ onLine: true, userAgent: 'node' });
});

test('bubble + Files row: a stored file offers SAVE, a pending one offers DOWNLOAD', async () => {
  await fresh();
  const storedRow = await stored({ id: 'bFile', kind: 'file', name: 'doc.pdf', mime: 'application/pdf' });
  const nodes = bubbleNodes({ dir: 'in', kind: 'file', state: 'delivered' }, storedRow, {});
  assert.ok(has(nodes, /media-save/), 'the file is here — so the button hands it to the device');
  assert.ok(!has(nodes, /media-dl/), '…and never both words for one thing');
  assert.match(nodes.map((x) => x.textContent).join(' '), /Save to device/);

  const pending = row({ id: 'bFile2', kind: 'file', name: 'doc2.pdf' });
  pending.state = 'pending';
  await store.saveMedia(pending);
  const pNodes = bubbleNodes({ dir: 'in', kind: 'file', state: 'delivered' }, pending, {});
  assert.ok(has(pNodes, /media-dl/) && has(pNodes, /media-decline/), 'req 6: download or delete-before-download');
  assert.ok(!has(pNodes, /media-save/), 'no save for bytes this device does not have');

  // an image keeps the bubble quiet: the viewer owns viewing and saving it
  const img = await stored({ id: 'bImg' });
  assert.ok(!has(bubbleNodes({ dir: 'in', kind: 'image', state: 'delivered' }, img, {}), /media-save/));

  // the Files tab row uses the same two states
  await store.saveMessage({ id: 'in:bf', peer: 'bobby', dir: 'in', kind: 'file', mediaId: 'bFile', ts: 5, text: 'File: doc.pdf' });
  await store.saveMessage({ id: 'in:bf2', peer: 'bobby', dir: 'in', kind: 'file', mediaId: 'bFile2', ts: 4, text: 'File: doc2.pdf' });
  const actions = [];
  const panel = dom.byId('chat-tabpanel');
  await view.paintTabPanel(panel, {
    peer: 'bobby', tab: 'files', query: '',
    onOpen: () => {}, onAction: (r, a) => actions.push([r.id, a]),
  });
  const rows = panel.querySelectorAll('.media-line');
  assert.equal(rows.length, 2);
  for (const el of rows) el.querySelector('.media-line-dl').click();
  assert.deepEqual(actions.sort(), [['bFile', 'save'], ['bFile2', 'download']],
    'each row does the honest thing for its state');
});

test('viewer: Expand sends a photo to the full-size lightbox, and closing both leaves no dangling URL', async () => {
  await fresh();
  const img = await stored({ id: 'vExp' });
  const host = dom.byId('msg-media');
  const teardown = view.openViewer(host, {
    client: fakeClient(), msg: { dir: 'in', kind: 'image' }, row: img,
    verified: true, onChange: () => {}, onStatus: () => {},
  });
  const expand = host.querySelectorAll('.viewer-toggle').find((b) => /Expand/i.test(b.textContent));
  assert.ok(expand, 'a 40vh picture is not "viewing" a photo on a phone');
  expand.click();
  const light = dom.byId('lightbox-img');
  assert.ok(light.src, 'the lightbox shows the same full-size Blob');
  assert.ok(dom.byId('lightbox-overlay').hidden === false, 'and it is on screen');

  // closing the viewer must close the expansion too: the lightbox holds the
  // SAME URL, and the teardown revokes it
  teardown();
  assert.ok(dom.byId('lightbox-overlay').hidden, 'no lightbox left pointing at a revoked Blob');
});

test('expand: an expanded photo is a rectangle, an avatar stays a circle', async () => {
  await fresh();
  const { openLightbox } = await import('../app/js/ui.js');
  const img = await stored({ id: 'vShape' });
  const host = dom.byId('msg-media');
  const teardown = view.openViewer(host, {
    client: fakeClient(), msg: { dir: 'in', kind: 'image' }, row: img,
    verified: true, onChange: () => {}, onStatus: () => {},
  });
  host.querySelectorAll('.viewer-toggle').find((b) => /Expand/i.test(b.textContent)).click();
  const light = dom.byId('lightbox-img');
  assert.ok(light.src, 'the expansion shows the full-size picture');
  assert.ok(!light.classList.contains('is-round'),
    'a chat photo is not an avatar: 50% radius would carve its corners off');

  openLightbox('data:image/jpeg;base64,AA');     // the profile-photo path
  assert.ok(light.classList.contains('is-round'),
    'and the avatar zoom this control was born for is untouched');
  teardown();
});

test('viewer: a PRUNED file may be fetched again; an expired one may not', async () => {
  await fresh();
  // 'pruned' is this device dropping bytes it already had — only the server
  // knows whether a copy survives (another device may still owe an ack), so
  // the honest UI asks it rather than guessing either way
  const pruned = await stored({ id: 'vPrune' });
  await store.updateMedia('vPrune', M.prunePatch(pruned));
  const again = await store.getMedia('vPrune');
  const host = dom.byId('msg-media');
  let teardown = view.openViewer(host, {
    client: fakeClient(), msg: { dir: 'in', kind: 'file' }, row: again,
    verified: true, onChange: () => {}, onStatus: () => {},
  });
  const dl = host.querySelectorAll('.viewer-toggle').find((b) => /Download again/i.test(b.textContent));
  assert.ok(dl, 'the button admits a second attempt is possible');
  assert.equal(dl.disabled, false, 'and does not refuse on the app\'s own guess');
  assert.ok(!/cannot be downloaded again/i.test(host.textContent), 'no claim it cannot back');
  teardown();

  // 'expired' IS settled — the server already said it has nothing
  const gone = row({ id: 'vGone2' });
  gone.state = 'expired'; gone.data = null; gone.thumb = null;
  await store.saveMedia(gone);
  teardown = view.openViewer(dom.byId('msg-media'), {
    client: fakeClient(), msg: { dir: 'in', kind: 'image' }, row: gone,
    verified: true, onChange: () => {}, onStatus: () => {},
  });
  const dead = dom.byId('msg-media').querySelectorAll('.viewer-toggle').find((b) => /Cannot be downloaded/i.test(b.textContent));
  assert.ok(dead && dead.disabled === true, 'a gone blob is stated, not retried');
  teardown();
});

test('viewer copy: Save and Keep cannot read as two strengths of the same verb', async () => {
  await fresh();
  const img = await stored({ id: 'copy1' });
  const host = dom.byId('msg-media');
  const teardown = view.openViewer(host, {
    client: fakeClient(), msg: { dir: 'in', kind: 'image' }, row: img,
    verified: true, onChange: () => {}, onStatus: () => {},
  });
  const labels = host.querySelectorAll('.viewer-toggle').map((b) => b.textContent.trim());
  const save = labels.find((t) => /Save/.test(t));
  const keep = labels.find((t) => /Keep/.test(t));
  assert.equal(save, 'Save to device', 'the one that leaves the app says device');
  assert.equal(keep, 'Keep in app', 'the one that stays says app');
  assert.ok(!/device/i.test(keep), 'Keep must not claim the device — that is the other button');
  assert.ok(!/\bapp\b/i.test(save), 'and Save must not sound in-app');
  teardown();
});
