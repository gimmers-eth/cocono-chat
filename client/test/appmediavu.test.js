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

const walkTags = (nodes, out = []) => {
  for (const node of nodes) {
    if (node?.tagName) out.push(node);
    if (node?.childNodes) walkTags(node.childNodes, out);
  }
  return out;
};
const tagsOf = (nodes) => walkTags(nodes).map((el) => el.tagName);
const findTag = (nodes, tag) => walkTags(nodes).find((el) => el.tagName === String(tag).toUpperCase()) ?? null;
const findClass = (nodes, cls) => walkTags(nodes).find((el) => (el.className || '').split(/\s+/).includes(cls)) ?? null;

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

test('bubble: a pruned row says SAVED when the phone has it, REMOVED when it aged out', async () => {
  await fresh();
  const saved = await stored({ id: 'pw1' });
  await store.updateMedia('pw1', { ...M.prunePatch({ ...saved, savedAt: Date.now() - 5 }) });
  const savedNodes = bubbleNodes({ dir: 'in', kind: 'image', state: 'delivered' }, await store.getMedia('pw1'), {});
  assert.match(savedNodes.map((x) => x.textContent).join(' '), /Saved to your phone/,
    'the person owns a copy — say that, not "removed"');
  assert.match(savedNodes.map((x) => x.textContent).join(' '), /preview only here/,
    'and explain the thumbnail that is left');

  const aged = await stored({ id: 'pw2' });
  await store.updateMedia('pw2', M.prunePatch(aged));
  const agedNodes = bubbleNodes({ dir: 'in', kind: 'file', state: 'delivered' }, await store.getMedia('pw2'), {});
  assert.match(agedNodes.map((x) => x.textContent).join(' '), /Removed from this device/);
  assert.ok(!/Saved/i.test(agedNodes.map((x) => x.textContent).join(' ')),
    'the app must not claim a save that never happened');
});

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

test('viewer: blur persists, and Save is a real download that stamps savedAt', async () => {
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

  // There is no pin any more — and that has to be asserted, because the
  // alternative is a button quietly reappearing next to Save years later
  assert.ok(!host.querySelectorAll('.viewer-toggle').some((b) => /Keep/i.test(b.textContent)),
    'no Keep button: Save-to-phone and the window are the two rules');
  assert.equal((await store.getMedia('vBlur')).keep, undefined);
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
  assert.equal(host.querySelectorAll('.viewer-toggle').filter((b) => /Download|Save/i.test(b.textContent)).length, 1,
    'ONE honest action: nothing is offered that cannot work yet');
  dl.click();
  await settle();
  assert.ok(cli.calls.some((c) => c.what === 'ack'), 'download then ack (req 8)');
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
  assert.equal(video.controls, false, 'no native controls: the app row owns them');
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
  // the engine's real primitives (the SDK verifies after the fetch, so a stub
  // that only implements downloadMedia would silently test nothing)
  cli.fetchMediaBytes = async (id) => { cli.calls.push({ what: 'download', id }); return new Uint8Array([1, 2, 3]); };
  cli.decryptMediaBytes = async (bytes, media) => {
    cli.calls.push({ what: 'verify' });
    return new Blob([bytes], { type: media?.mime || 'application/octet-stream' });
  };
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

test('save: pressing Save downloads — it does NOT open a share sheet', async () => {
  await fresh();
  // the phone case: a share SHEET is a chooser, not a result, and the report
  // was exactly that ('opens the OS share and does not save the file'), so the
  // download anchor is the primary door even when sharing is available
  let shared = 0;
  setNavigator({ canShare: () => true, share: async () => { shared += 1; } });
  const row = await stored({ id: 'sv1', kind: 'file', name: 'invoice', mime: 'application/pdf' });
  const before = dom.created.length;
  const res = await M.saveToDevice(row);
  assert.equal(res.ok, true);
  assert.equal(res.how, 'saved');
  assert.equal(shared, 0, 'the share sheet must not open on a normal Save');
  const anchor = dom.created.slice(before).find((el) => el.tagName === 'A');
  assert.equal(anchor.download, 'invoice.pdf', 'the extension is added — a nameless file opens nowhere');
  assert.equal((await store.getMedia('sv1')).savedAt > 0, true,
    'and the record is stamped, which is what lets the sweep release the duplicate');
  setNavigator({ onLine: true, userAgent: 'node' });
});

test('save: an engine that blocks downloads gets ONE explicit fallback', async () => {
  await fresh();
  let shared = 0;
  setNavigator({ canShare: () => true, share: async () => { shared += 1; } });
  const row = await stored({ id: 'sv2' });
  // no <a download> support: the anchor door refuses, then Share is offered
  const realCreate = document.createElement.bind(document);
  document.createElement = (tag) => {
    const el = realCreate(tag);
    // DELETE the property: the code under test asks `'download' in a`, which is
    // exactly how a browser without download support presents (an own property
    // set to undefined would still answer true — that is the whole check)
    if (String(tag).toLowerCase() === 'a') delete el.download;
    return el;
  };
  const host = dom.byId('msg-media');
  const statuses = [];
  const teardown = view.openViewer(host, {
    client: fakeClient(), msg: { dir: 'in', kind: 'image' }, row,
    verified: true, onChange: () => {}, onStatus: (t) => statuses.push(t),
  });
  const togglesBefore = host.querySelectorAll('.viewer-toggle').length;
  host.querySelectorAll('.viewer-toggle').find((b) => /Save to device/i.test(b.textContent)).click();
  await settle(30);
  document.createElement = realCreate;
  assert.equal(shared, 0, 'Share is not opened behind the user\'s back');
  const share = host.querySelectorAll('.viewer-toggle').find((b) => /Share instead/i.test(b.textContent));
  assert.ok(share, 'the fallback APPEARS only after the download door fails');
  assert.equal(host.querySelectorAll('.viewer-toggle').length, togglesBefore + 1,
    'exactly one new control appeared — the revealed fallback, nothing else');
  share.click();
  await settle();
  assert.equal(shared, 1, 'and it is one tap away when they want it');
  assert.ok((await store.getMedia('sv2')).savedAt > 0);
  teardown();
  setNavigator({ onLine: true, userAgent: 'node' });
});

test('save: a dismissed share sheet is not an error, and no bytes is no save', async () => {
  await fresh();
  setNavigator({
    canShare: () => true,
    share: async () => { const e = new Error('dismissed'); e.name = 'AbortError'; throw e; },
  });
  const withBytes = await stored({ id: 'sv3' });
  // the SHARE door (the fallback) keeps the cancelled distinction; the download
  // door has no sheet to dismiss at all
  const dismissed = await M.shareToDevice(withBytes);
  assert.equal(dismissed.ok, false);
  assert.equal(dismissed.how, 'cancelled',
    'a share sheet the user closed must not be reported as a failure');
  assert.equal((await store.getMedia('sv3')).savedAt, null,
    'and nothing is stamped: no save happened, so the app keeps its copy');

  setNavigator({ canShare: () => true, share: async () => {} });
  // a record with no bytes (never fetched, or already pruned): both doors must
  // refuse WITHOUT stamping savedAt — a pruned row must not look saved
  const nothing = { ...row({ id: 'sv4' }), data: null, state: 'pruned' };
  await store.saveMedia(nothing);
  assert.equal((await M.saveToDevice(nothing)).how, 'none', 'nothing to hand over: no anchor, no sheet');
  assert.equal((await M.shareToDevice(nothing)).how, 'none');
  assert.equal((await store.getMedia('sv4')).savedAt, null, 'and the record is untouched');
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

test('viewer copy: exactly one save door, and no pin to confuse it with', async () => {
  await fresh();
  const img = await stored({ id: 'copy1' });
  const host = dom.byId('msg-media');
  const teardown = view.openViewer(host, {
    client: fakeClient(), msg: { dir: 'in', kind: 'image' }, row: img,
    verified: true, onChange: () => {}, onStatus: () => {},
  });
  const labels = host.querySelectorAll('.viewer-toggle').map((b) => b.textContent.trim());
  assert.deepEqual(labels.filter((t) => /Save|Keep|Share/.test(t)), ['Save to device'],
    'one door out of the app, named for what it does; the pin is gone and Share is a revealed fallback');
  assert.ok(labels.some((t) => /Expand/i.test(t)), 'a photo also gets the full-size view');
  teardown();
});

// ---------------- the video display bugs ----------------

test('viewer: a video plays ONLY on press — never autoplay, never loop, no native chrome', async () => {
  await fresh();
  const vid = await stored({ id: 'vFlags', kind: 'video' });
  const host = dom.byId('msg-media');
  const teardown = view.openViewer(host, {
    client: fakeClient(), msg: { dir: 'in', kind: 'video' }, row: vid,
    verified: true, onChange: () => {}, onStatus: () => {},
  });
  const video = host.querySelector('.viewer-video');
  assert.ok(video, 'with the bytes on the device, the player is there');
  assert.equal(video.autoplay, false, 'a video must not start by itself');
  assert.equal(video.loop, false, 'and certainly not on a loop');
  assert.equal(video.controls, false, 'the control row owns play/mute, not the UA');
  assert.equal(video.paused, true, 'it is still paused before the tap');
  teardown();
});

test('viewer: a NOT-downloaded video is a poster and a Download button — never a <video> over a JPEG', async () => {
  await fresh();
  const poster = new Blob(['JPEGDATA'], { type: 'image/jpeg' });
  const v = { ...row({ id: 'vNope', kind: 'video' }), state: 'pending', data: null, thumb: poster };
  await store.saveMedia(v);
  const host = dom.byId('msg-media');
  const teardown = view.openViewer(host, {
    client: fakeClient(), msg: { dir: 'in', kind: 'video' }, row: v,
    verified: true, onChange: () => {}, onStatus: () => {},
  });
  assert.equal(host.querySelector('.viewer-video'), null,
    'feeding <video> the poster is how the could-not-be-played error was manufactured');
  assert.ok(host.querySelector('.viewer-poster'), 'the poster is what shows');
  assert.ok(host.querySelectorAll('.viewer-toggle').some((b) => /Download/i.test(b.textContent)));
  teardown();
});

test('bubble: a video is never painted as an <img> over its own video bytes', async () => {
  await fresh();
  const mp4 = new Blob([new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70])], { type: 'video/mp4' });
  const v = { ...row({ id: 'vImg', kind: 'video' }), state: 'stored', data: mp4, thumb: null };
  await store.saveMedia(v);
  const msg = { dir: 'in', kind: 'video', state: 'delivered' };

  // Default paint: NO media element. A transcript of 18 clips is 18 decoders,
  // and a phone runs out — the element that then fails is the message modal's,
  // which reads as "this browser cannot decode that video".
  const nodes = bubbleNodes(msg, v, {});
  assert.ok(!tagsOf(nodes).includes('IMG'), 'no <img> pointed at video bytes (the looping mess)');
  assert.equal(findTag(nodes, 'VIDEO'), null, 'and no <video> either, until someone presses play');
  assert.ok(has(nodes, /media-plain/), 'a labelled tile stands in for the picture');
  assert.equal(findClass(nodes, 'media-play-badge'), null,
    'a tile has nothing to overlay: the tap opens the modal, which owns playback');

  // The newest poster-less clips are allowed an element, so the bubble is a
  // picture rather than a tile — that is chat.js's PREVIEW_VIDEO_MAX budget.
  const shown = bubbleNodes(msg, v, { videoPreview: true });
  const clip = findTag(shown, 'VIDEO');
  assert.ok(clip, 'within the budget, the clip paints its own frame');
  const badge = findClass(shown, 'media-play-badge');
  assert.equal(badge.tagName, 'BUTTON', 'and the badge on it is a control: the bytes are here');
  assert.equal(badge.dataset.act, 'playpause');
  assert.match(clip.src, /#t=0\.1$/, 'with a media fragment, or the box stays black until Play');
  assert.equal(clip.muted, true, 'a bubble never makes a sound by itself');
  assert.equal(clip.autoplay, false);
  assert.equal(clip.loop, false);
  assert.equal(clip.controls, false);

  // an engine that cannot decode it (HEVC/.mov on Chromium) must not leave a
  // black rectangle: the labelled tile takes over, in place, on `error`
  clip.error = { code: 4 };
  clip.fire('error');
  assert.ok(has([shown[0]], /media-plain/), 'undecodable → the tile, with the name and size');
  assert.match(shown.map((x) => x.textContent).join(' '), /a\.mp4/);
});

test('bubble: a video this device does NOT hold is a labelled tile with a download', async () => {
  await fresh();
  const v = { ...row({ id: 'vFar', kind: 'video', size: 40 * 1024 * 1024 }), state: 'pending', data: null, thumb: null };
  await store.saveMedia(v);
  const nodes = bubbleNodes({ dir: 'in', kind: 'video', state: 'delivered' }, v, {});
  assert.equal(findTag(nodes, 'VIDEO'), null, 'nothing to decode here yet');
  assert.ok(has(nodes, /media-plain/), 'a tile says video until the bytes arrive');
  assert.match(nodes.map((x) => x.textContent).join(' '), /a\.mp4/, 'and names the file it stands for');
  assert.match(nodes.map((x) => x.textContent).join(' '), /Download/, 'with the tap that fetches it');
});

test('bubble: a poster paints a JPEG — and the player carries the same JPEG, so nothing flashes', async () => {
  await fresh();
  const mp4 = new Blob([new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70])], { type: 'video/mp4' });
  const poster = new Blob(['JPEG'], { type: 'image/jpeg' });
  const v = { ...row({ id: 'vPosterBubble', kind: 'video' }), state: 'stored', data: mp4, thumb: poster };
  await store.saveMedia(v);
  const msg = { dir: 'in', kind: 'video', state: 'delivered' };

  const nodes = bubbleNodes(msg, v, {});
  const still = findTag(nodes, 'IMG');
  assert.ok(still, 'the poster JPEG is the preview: free, and holds no decoder');
  const cls = (still.className || '').split(/\s+/);
  assert.ok(!cls.includes('media-video'),
    'and it does NOT wear the player class: chat.js looks .media-video up and calls play() on what it finds, '
    + 'which is how one tap tore the player down and the next built it again');
  assert.ok(cls.includes('media-poster'), 'it wears its own');
  assert.equal(findTag(nodes, 'VIDEO'), null, 'no media element until the badge is pressed');
  const badge = findClass(nodes, 'media-play-badge');
  assert.equal(badge.tagName, 'BUTTON', 'and the badge is a control, because the bytes are here');
  assert.equal(badge.dataset.act, 'playpause');

  // playing: the element exists, and its poster is the SAME picture, so swapping
  // <img> → <video> changes nothing on screen until real frames arrive. That gap
  // was the "video disappears and reappears when I press play" report.
  const on = bubbleNodes(msg, v, { playing: true });
  const clip = findTag(on, 'VIDEO');
  assert.ok(clip, 'the playing row gets the one player');
  assert.match(clip.poster, /^blob:local\//, 'carrying the poster it replaces');
  assert.equal(clip.preload, 'auto', 'and loading for real, not on demand');
  assert.equal(findTag(on, 'IMG'), null, 'one picture, not two');
  assert.ok(has(on, /media-play-badge is-playing/), 'the badge already says pause');
});

test('bubble: a poster with no bytes is a picture, and the badge is decoration', async () => {
  await fresh();
  const poster = new Blob(['JPEG'], { type: 'image/jpeg' });
  const v = { ...row({ id: 'vPosterOnly', kind: 'video' }), state: 'pending', data: null, thumb: poster };
  await store.saveMedia(v);
  const nodes = bubbleNodes({ dir: 'in', kind: 'video', state: 'delivered' }, v, {});
  assert.equal(findTag(nodes, 'VIDEO'), null, 'there is nothing here to play');
  assert.ok(findTag(nodes, 'IMG'), 'so the poster is what shows');
  const badge = nodes.flatMap((n) => walkTags([n])).find((el) => el.className.includes('media-play-badge'));
  assert.equal(badge.tagName, 'SPAN', 'a badge that cannot play must not look like a button');
  assert.equal(badge.dataset.act, undefined);
});

test('bubble: an outgoing draft carries its progress in the message, not in a toast', async () => {
  await fresh();
  const f = new Blob([new Uint8Array(2048)], { type: 'video/quicktime' });
  const draft = { ...row({ id: 'out:d1', kind: 'video', name: 'IMG_0001.MOV' }), state: 'preparing', data: f, thumb: null, progress: 0.4 };
  await store.saveMedia(draft);
  const nodes = bubbleNodes({ dir: 'out', kind: 'video', state: 'sending' }, draft, {});
  const text = nodes.map((x) => x.textContent ?? '').join(' ');
  assert.match(text, /Preparing video/, 'the bubble says what the phone is doing');
  const fill = nodes.flatMap((n) => walkTags([n])).find((el) => el.className.includes('media-progress-fill'));
  assert.ok(fill, 'with a determinate bar');
  assert.equal(fill.style.width, '40%', 'showing how far along it is');

  // and the upload phase reuses the same bar, from the SDK's own byte count
  const up = { ...draft, state: 'uploading', progress: 0.8 };
  await store.saveMedia(up);
  const upNodes = bubbleNodes({ dir: 'out', kind: 'video', state: 'sending' }, up, {});
  assert.match(upNodes.map((x) => x.textContent ?? '').join(' '), /Uploading/);
  const upFill = upNodes.flatMap((n) => walkTags([n])).find((el) => el.className.includes('media-progress-fill'));
  assert.equal(upFill.style.width, '80%');
});

test('poster: the recipient draws its own frame once the bytes land, typed correctly', async () => {
  await fresh();
  const mp4 = new Blob([new Uint8Array([0, 0, 0, 0x18])], { type: 'video/mp4' });
  const v = { ...row({ id: 'vPoster', kind: 'video' }), state: 'stored', data: mp4, thumb: null };
  await store.saveMedia(v);
  // stub the decode surface the shim cannot provide: metadata + a painted
  // frame + a JPEG out, so the LOGIC (typed blob, persist, dims) is what is
  // actually under test here
  const seen = [];
  const realCreate = document.createElement.bind(document);
  document.createElement = (tag) => {
    const el = realCreate(tag);
    if (el.tagName === 'VIDEO') {
      el.videoWidth = 1920; el.videoHeight = 1080; el.duration = 12;
      el.readyState = 4;
      Object.defineProperty(el, 'src', { set(v2) { seen.push(v2); el.onloadedmetadata?.(); } });
    }
    if (el.tagName === 'CANVAS') {
      el.getContext = () => ({ drawImage() {} });
      el.toBlob = (cb) => cb(new Blob(['poster'], { type: 'image/jpeg' }));
    }
    return el;
  };
  const out = await M.buildPoster(await store.getMedia('vPoster'));
  document.createElement = realCreate;
  assert.ok(out, 'a frame was produced');
  assert.equal((await store.getMedia('vPoster')).thumb.size, 6, 'and stored on the record');
  assert.equal((await store.getMedia('vPoster')).w, 1920, 'with the real dimensions');
  assert.equal((await store.getMedia('vPoster')).dur, 12);
  assert.match(seen[0], /^blob:local\//);
  // an undecodable video keeps its record exactly as it was
  const v2 = { ...row({ id: 'vPoster2', kind: 'video' }), state: 'stored', data: mp4, thumb: null };
  await store.saveMedia(v2);
  assert.equal(await M.buildPoster(await store.getMedia('vPoster2')), null,
    'no poster, no crash, no harm to the download');
  assert.equal((await store.getMedia('vPoster2')).thumb, null);
});

test('poster: the decoder element is IN THE DOCUMENT while it runs', async () => {
  // WebKit hands no decoded frames to a detached <video>, which is why every
  // poster from an iPhone came back empty (thumbCtSize: null on all of them).
  // Staging is the fix; this asserts it happened, and that it is undone.
  const mp4 = new Blob([new Uint8Array([0, 0, 0, 0x18])], { type: 'video/mp4' });
  const seen = { attachedAtPlay: null, attachedAtEnd: null, el: null };
  const realCreate = document.createElement.bind(document);
  document.createElement = (tag) => {
    const el = realCreate(tag);
    if (el.tagName === 'VIDEO') {
      el.videoWidth = 640; el.videoHeight = 480; el.duration = 4; el.readyState = 4; el.currentTime = 0.1;
      el.requestVideoFrameCallback = (cb) => { cb(); return 1; };
      el.play = async () => { seen.attachedAtPlay = el.parentNode === document.body; };
      Object.defineProperty(el, 'src', {
        configurable: true,
        get: () => el._src ?? '',
        set(v) { el._src = v; setTimeout(() => el.fire('loadedmetadata'), 0); },
      });
      seen.el = el;
    }
    if (el.tagName === 'CANVAS') {
      el.getContext = () => ({ drawImage() {}, getImageData: () => ({ data: new Uint8Array([200, 120, 40, 255]) }) });
      el.toBlob = (cb) => cb(new Blob(['poster'], { type: 'image/jpeg' }));
    }
    return el;
  };
  const out = await M.grabVideoFrame(mp4);
  document.createElement = realCreate;
  seen.attachedAtEnd = seen.el?.parentNode === document.body;
  assert.ok(out.thumb, 'a poster came back');
  assert.equal(out.w, 640);
  assert.equal(out.dur, 4);
  assert.equal(seen.attachedAtPlay, true, 'play() ran on an attached element, so frames are delivered');
  assert.equal(seen.attachedAtEnd, false, 'and it is taken back off the page afterwards');
});
test('bubble: a video with no poster is a labelled tile, not a lone glyph', async () => {
  const row = {
    id: 'v1', blobId: 'v1', kind: 'video', dir: 'in', name: 'IMG_0432.MOV', mime: 'video/quicktime',
    size: 2_400_000, dur: 8.4, state: 'pending', thumb: null, data: null, blurred: null,
  };
  const nodes = bubbleNodes({ dir: 'in', kind: 'video', state: 'delivered' }, row, {});
  const text = nodes.map((n) => n.textContent ?? '').join(' ');
  assert.match(text, /IMG_0432\.MOV/, 'the name is there');
  assert.match(text, /2\.3 MB/, 'the size is there');
  assert.match(text, /0:08/, 'and the clip length, so it reads as a video');
  const cls = nodes.flatMap((n) => [n.className, ...(n.childNodes ?? []).map((c) => c.className)]).join(' ');
  assert.match(cls, /media-plain/, 'as a tile, not a bare icon');
});

test('drafts: a send the app did not finish is settled, not left spinning', async () => {
  await fresh();
  const bytes = new Blob([new Uint8Array(64)], { type: 'video/mp4' });
  // mid-prepare, bytes on this device: the user keeps their clip, the message
  // is what says it never went
  await store.saveMedia({ ...row({ id: 'out:d1', kind: 'video', msgId: 'out:d1' }), state: 'preparing', data: bytes, progress: 0.4 });
  // mid-upload with nothing local: a failure, and no claim to bytes we do not have
  await store.saveMedia({ ...row({ id: 'out:d2', kind: 'image', msgId: 'out:d2' }), state: 'uploading', data: null, progress: 0.6 });
  // a settled row is none of this function's business
  await store.saveMedia({ ...row({ id: 'b-kept', kind: 'image' }), state: 'stored', data: bytes });

  const ids = await M.reapStaleDrafts();
  assert.deepEqual(ids.sort(), ['out:d1', 'out:d2'], 'both unfinished sends are reported for their message to be marked');
  const d1 = await store.getMedia('out:d1');
  assert.equal(d1.state, 'stored', 'the bytes were here, so the copy is kept');
  assert.equal(d1.progress, 0, 'and the bar comes down');
  const d2 = await store.getMedia('out:d2');
  assert.equal(d2.state, 'failed', 'no bytes, no claim: failed');
  assert.equal((await store.getMedia('b-kept')).state, 'stored', 'a settled row is untouched');
});
