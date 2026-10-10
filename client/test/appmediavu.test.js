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
  assert.match(bubbleNodes({ dir: 'in', kind: 'image' }, expired, {}).map((x) => x.textContent).join(' '), /No longer available/);
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
