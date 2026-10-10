// Conversation tabs + the full-size media viewer (M4, req 1/3/4/7).
//
// Stateless on purpose: chat.js owns WHICH tab is open and WHICH message is
// in the modal (it already owns render(), the composer and the modal
// lifecycle); this module owns how media LOOKS and what the controls DO.
// Keeping the split that way means the modal keeps surviving render() — the
// lesson in chat.js' header comment (in-bubble action bars were wiped by the
// click-triggered catch-up re-render, which is why interactions live in
// overlay DOM).
//
// No innerHTML anywhere: every node is built with createElement/textContent,
// which is also what makes a sender-controlled filename harmless.

import { iconEl } from '../icons.js';
import { mediaWith, messagesWith, updateMedia } from '../store.js';
import {
  formatSize, durationText, isBlurred, objectUrl, releaseScope, filterMedia,
  tabBuckets, downloadMedia, declineMedia, renderableAsImage,
} from '../media.js';

// exported so chat.js and the tests agree on the vocabulary
export const TABS = ['chat', 'images', 'videos', 'files', 'links'];
export const TAB_ICON = {
  chat: 'tabChat', images: 'tabImages', videos: 'tabVideos', files: 'tabFiles', links: 'tabLinks',
};
// a tile/row is SENT (accent border) or RECEIVED (neutral border) — colour
// only, so it reads in every theme (req 4)
const dirClass = (row) => (row.dir === 'out' ? 'media-sent' : 'media-recv');

const mk = (tag, cls, text) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined && text !== null) el.textContent = text;
  return el;
};

const btn = (cls, iconKey, label, title) => {
  const b = mk('button', cls);
  b.type = 'button';
  if (iconKey) b.append(iconEl(iconKey));
  if (label !== null) b.append(document.createTextNode(label ? ` ${label}` : ' '));
  if (title) b.title = title;
  return b;
};

const dateText = (ts) => (ts ? new Date(ts).toLocaleDateString() : '');

// ---------------- the tab strip ----------------

export function buildTabStrip(host, { onChange }) {
  host.replaceChildren();
  for (const tab of TABS) {
    const b = btn(`chat-tab${tab === 'chat' ? ' active' : ''}`, TAB_ICON[tab], null, {
      chat: 'Chat', images: 'Images', videos: 'Videos', files: 'Files', links: 'Links',
    }[tab]);
    b.dataset.tab = tab;
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(tab === 'chat'));
    b.addEventListener('click', () => onChange(tab));
    host.append(b);
  }
}

export function paintTabActive(host, tab) {
  for (const b of host.querySelectorAll('.chat-tab')) {
    const on = b.dataset.tab === tab;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  }
}

// ---------------- the tab panels ----------------

function tile(row, { blur, caption, onOpen }) {
  const t = mk('button', `media-tile ${dirClass(row)}`);
  t.type = 'button';
  const pic = row.thumb ?? (row.kind === 'image' ? row.data : null);
  if (pic && pic.size) {
    const img = mk('img', `media-tile-img${blur ? ' is-blurred' : ''}`);
    img.alt = '';
    img.decoding = 'async';
    img.src = objectUrl(pic, 'bubbles');
    t.append(img);
  } else {
    const ic = mk('span', 'media-tile-icon');
    ic.append(iconEl(row.kind === 'video' ? 'tabVideos' : 'attachFile'));
    t.append(ic);
  }
  if (row.kind === 'video') {
    const badge = mk('span', 'media-play-badge');
    badge.append(iconEl('mediaPlay'));
    t.append(badge);
  }
  if (caption) t.append(mk('span', 'media-tile-caption', caption));
  t.addEventListener('click', () => onOpen(row));
  return t;
}

function fileRowEl(row, { onOpen, onAction }) {
  const li = mk('li', 'media-list-row');
  const b = mk('button', `media-line ${dirClass(row)}`);
  b.type = 'button';
  const ic = mk('span', 'media-line-icon');
  ic.append(iconEl(row.kind === 'video' ? 'tabVideos' : 'attachFile'));
  const meta = mk('span', 'media-line-meta');
  meta.append(mk('span', 'media-line-name', row.name || 'attachment'));
  meta.append(mk('span', 'media-line-sub',
    `${formatSize(row.size)} · ${dateText(row.ts)} · ${row.dir === 'out' ? 'sent' : 'received'}${row.state === 'expired' ? ' · gone from the server' : ''}${row.state === 'pruned' ? ' · removed from this device' : ''}`));
  b.append(ic, meta);
  if (row.state === 'pending' || row.state === 'synced' || row.state === 'failed') {
    const dl = btn('media-line-dl', 'mediaDownload', null, 'Download this file');
    dl.addEventListener('click', (e) => {
      e.stopPropagation();               // the row itself opens the viewer
      onAction?.(row, 'download');
    });
    b.append(dl);
  }
  b.addEventListener('click', () => onOpen(row));
  li.append(b);
  return li;
}

function linkRow(item) {
  const li = mk('li', 'link-row');
  const a = mk('a', `link-line ${item.dir === 'out' ? 'media-sent' : 'media-recv'}`);
  a.href = item.url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  const ic = mk('span', 'link-icon');
  ic.append(iconEl('tabLinks'));
  const meta = mk('span', 'link-meta');
  meta.append(mk('span', 'link-host', item.host));
  meta.append(mk('span', 'link-snippet', item.snippet || ''));
  a.append(ic, meta);
  li.append(a);
  return li;
}

const emptyNote = (text) => {
  const p = mk('p', 'media-empty', text);
  return p;
};

/**
 * Render one tab's panel. `onOpen(row)` gets the media record behind a tap
 * (chat.js decides what that means — it owns the modal).
 */
export async function paintTabPanel(host, { peer, tab, query = '', verified = false, onOpen, onAction }) {
  if (!peer || tab === 'chat') { host.replaceChildren(); return { count: 0 }; }
  // ONE stable skeleton (search bar + body) is built per tab; re-painting a
  // keystroke's worth of results replaces only the BODY — rebuilding the
  // input too would drop the caret the user is still typing into.
  const skeleton = host.dataset.tab === tab ? host : beginPanel(host, tab);
  const body = skeleton.querySelector('.tab-body');
  body.replaceChildren();
  const [msgs, rows] = await Promise.all([messagesWith(peer), mediaWith(peer)]);
  const buckets = tabBuckets(msgs, rows);
  if (tab === 'images' || tab === 'videos') {
    const list = buckets[tab];
    if (!list.length) {
      body.append(emptyNote(tab === 'images' ? 'No images in this conversation yet.' : 'No videos in this conversation yet.'));
      return { count: 0 };
    }
    const wall = mk('div', 'media-wall');
    for (const row of list) {
      wall.append(tile(row, {
        // req 7: an unverified SENDER's image is blurred by default, and the
        // record's own toggle (row.blurred) wins — same rule as the transcript
        blur: tab === 'images' && isBlurred(row, verified),
        caption: row.kind === 'video' && row.dur ? durationText(row.dur) : null,
        onOpen,
      }));
    }
    body.append(wall);
    return { count: list.length };
  }
  if (tab === 'files') {
    const list = filterMedia(buckets.files, query);
    if (!list.length) body.append(emptyNote(query ? 'No files match that search.' : 'No files in this conversation yet.'));
    const ul = mk('ul', 'media-list');
    host._files = buckets.files;   // UNFILTERED: the search box narrows this
    host._onOpen = onOpen;
    host._onAction = onAction;
    for (const row of list) ul.append(fileRowEl(row, { onOpen, onAction }));
    body.append(ul);
    return { count: list.length };
  }
  // links: pulled out of the transcript itself — nothing new on the wire
  const list = buckets.links;
  if (!list.length) body.append(emptyNote('No links in this conversation yet.'));
  const ul = mk('ul', 'link-list');
  for (const item of list) ul.append(linkRow(item));
  body.append(ul);
  return { count: list.length };
}

function beginPanel(host, tab) {
  host.replaceChildren();
  host.dataset.tab = tab;
  const body = mk('div', 'tab-body');
  if (tab !== 'files') { host.append(body); return host; }
  const bar = mk('label', 'media-search');
  const input = mk('input');
  input.type = 'text';
  input.placeholder = 'Search files by name';
  input.maxLength = 120;
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.addEventListener('input', () => {
    // re-filter straight from the ALREADY loaded rows: an IDB round trip per
    // keystroke would make the search feel like it was thinking
    const list = filterMedia(host._files ?? [], input.value);
    const ul = body.querySelector('.media-list') ?? (() => { const u = mk('ul', 'media-list'); body.replaceChildren(u); return u; })();
    ul.replaceChildren();
    const none = body.querySelector('.media-empty');
    if (!list.length) ul.append(emptyNote('No files match that search.'));
    else if (none) none.remove();
    for (const row of list) ul.append(fileRowEl(row, { onOpen: host._onOpen, onAction: host._onAction }));
  });
  bar.append(iconEl('magnifier'), input);
  host.append(bar, body);
  return host;
}

/** A media row's bubble actions (Download / Delete), shared by the transcript
 *  and the Files tab so both do exactly the same thing. */
export async function mediaAction(client, row, action, { onDone } = {}) {
  if (!row) return;
  if (action === 'download') await downloadMedia(client, row);
  else if (action === 'decline') await declineMedia(client, row);
  onDone?.();
}

// ---------------- the viewer (inside the message modal) ----------------

/**
 * Fill the modal's media pane for one message. Returns a cleanup that revokes
 * the full-size object URLs — chat.js calls it on close (and before any
 * re-open, so a burst of taps cannot pile up viewers).
 *
 * Controls (req 3): image → Blur/Unblur, plus Play/Pause when animated;
 * video → Play/Pause, Mute/Unmute, Blur/Unblur; file → Download. Every kind
 * also gets Keep (pin against the local prune, §4.5) and Download when the
 * bytes are not on the device yet.
 */
export function openViewer(host, { client, msg, row, verified, onChange, onStatus }) {
  host.replaceChildren();
  if (!row) {
    host.append(emptyNote('This attachment is not on this device.'));
    return () => { host.replaceChildren(); };
  }
  const status = (text, isError) => onStatus?.(text, isError);

  // viewer-kind-<kind>, NOT viewer-<kind>: the latter collided with the
  // .viewer-image / .viewer-video element inside the pane, so every
  // host.querySelector('.viewer-image') hit the CONTAINER (found by running
  // this UI under the DOM shim — a real bug no static check could see)
  const isImage = renderableAsImage(row);
  const shape = row.kind === 'video' ? 'video' : (isImage ? 'image' : 'file');
  const pane = mk('div', `viewer-pane viewer-kind-${shape}`);
  const blur = isImage && isBlurred(row, verified);

  const full = row.data ?? row.thumb ?? null;
  if (shape === 'file') {
    const card = mk('div', 'viewer-file');
    const ic = mk('span', 'viewer-file-icon');
    ic.append(iconEl('attachFile'));
    card.append(ic);
    card.append(mk('p', 'viewer-file-name', row.name || 'attachment'));
    card.append(mk('p', 'muted small', `${formatSize(row.size)} · ${new Date(row.ts).toLocaleString()}`));
    if (row.state === 'expired') card.append(mk('p', 'media-status', 'No longer available on the server.'));
    if (row.state === 'pruned') card.append(mk('p', 'media-status', 'Removed from this device — it cannot be downloaded again.'));
    pane.append(card);
  } else if (full && full.size) {
    if (isImage) {
      const url = objectUrl(full, 'viewer');
      const img = mk('img', `viewer-image${blur ? ' is-blurred' : ''}`);
      img.alt = '';
      img.src = url;
      pane.append(img);
      if (row.animated) {
        // native GIF playback cannot be paused in an <img>; pausing SHOWS the
        // static poster and resuming swaps the animated bytes back (plan §6.4
        // — do not fight the platform)
        const staticUrl = row.thumb ? objectUrl(row.thumb, 'viewer') : '';
        let playing = true;
        const toggle = btn('viewer-toggle', 'mediaPause', 'Pause', 'Pause the animation');
        toggle.addEventListener('click', () => {
          playing = !playing;
          img.src = playing ? url : (staticUrl || url);
          toggle.replaceChildren(iconEl(playing ? 'mediaPause' : 'mediaPlay'), document.createTextNode(playing ? ' Pause' : ' Play'));
        });
        pane.append(toggle);
      }
    } else {
      const url = objectUrl(full, 'viewer');
      const video = mk('video', 'viewer-video');
      video.src = url;
      video.playsInline = true;   // NO native controls: the row below is ours
      video.preload = 'metadata';
      if (row.thumb && row.thumb.size) video.poster = objectUrl(row.thumb, 'viewer');
      const play = btn('viewer-toggle', 'mediaPlay', 'Play', 'Play this video');
      play.addEventListener('click', () => {
        if (video.paused) video.play().catch(() => status('This video could not be played here.'));
        else video.pause();
      });
      video.addEventListener('play', () => play.replaceChildren(iconEl('mediaPause'), document.createTextNode(' Pause')));
      video.addEventListener('pause', () => play.replaceChildren(iconEl('mediaPlay'), document.createTextNode(' Play')));
      const sound = btn('viewer-toggle', 'mediaUnmute', 'Mute', 'Mute this video');
      sound.addEventListener('click', () => {
        video.muted = !video.muted;
        sound.replaceChildren(
          iconEl(video.muted ? 'mediaMute' : 'mediaUnmute'),
          document.createTextNode(video.muted ? ' Unmute' : ' Mute'),
        );
      });
      video.muted = true; // a video that starts itself with sound is a hostile default
      sound.replaceChildren(iconEl('mediaMute'), document.createTextNode(' Unmute'));
      pane.append(video, play, sound);
    }
  } else {
    // no bytes here yet: the poster (when one was fetched) plus the honest
    // explanation of WHY there is nothing to look at — 'expired' (the server
    // deleted it), 'pruned' (this device aged it out) and 'pending' (never
    // downloaded) are three different sentences and three different futures
    const pic = row.thumb && row.thumb.size ? previewStill(row) : null;
    if (pic) pane.append(pic);
    const note = mk('span', 'viewer-waiting');
    note.append(iconEl(row.kind === 'video' ? 'tabVideos' : 'attachFile'));
    note.append(document.createTextNode(
      row.state === 'expired' ? ' No longer available on the server.'
        : row.state === 'pruned' ? ' Removed from this device — it cannot be downloaded again.'
          : row.state === 'declined' ? ' Deleted here without downloading.'
            : ' Not downloaded on this device yet.',
    ));
    pane.append(note);
  }
  host.append(pane);

  // ---- control row ----
  const controls = mk('div', 'viewer-controls');
  if (isImage) {
    const b = btn('viewer-toggle', blur ? 'mediaUnblur' : 'mediaBlur', blur ? 'Unblur' : 'Blur',
      'Show or hide this image');
    b.addEventListener('click', async () => {
      const next = !(host.querySelector('.viewer-image')?.classList.contains('is-blurred') ?? false);
      const img = host.querySelector('.viewer-image');
      if (img) img.classList.toggle('is-blurred', next);
      b.replaceChildren(iconEl(next ? 'mediaUnblur' : 'mediaBlur'), document.createTextNode(next ? 'Unblur' : 'Blur'));
      await updateMedia(row.id, { blurred: next });
      onChange?.({ ...row, blurred: next });
    });
    controls.append(b);
  }
  if (row.kind === 'video') {
    const b = btn('viewer-toggle', 'mediaUnblur', 'Blur', 'Blur this video');
    b.addEventListener('click', () => {
      const v = host.querySelector('.viewer-video');
      if (!v) return;
      const on = !v.classList.contains('is-blurred');
      v.classList.toggle('is-blurred', on);
      b.replaceChildren(iconEl(on ? 'mediaUnblur' : 'mediaBlur'), document.createTextNode(on ? 'Unblur' : 'Blur'));
    });
    controls.append(b);
  }
  if (row.state !== 'stored') {
    const dl = btn('viewer-toggle', 'mediaDownload', row.state === 'pruned' ? 'Cannot re-download' : 'Download',
      'Download the full file to this device');
    if (row.state === 'pruned' || row.state === 'expired' || row.state === 'declined') dl.disabled = true;
    dl.title = row.state === 'pruned' || row.state === 'expired'
      ? 'The server no longer holds this file — it cannot be downloaded again.'
      : 'Download the full file to this device';
    dl.addEventListener('click', async () => {
      dl.disabled = true;
      status('Downloading…');
      const res = await downloadMedia(client, row);
      status(res.ok ? 'Downloaded ✓' : res.state === 'expired' ? 'No longer available on the server.' : 'Download failed — try again later.', !res.ok);
      onChange?.(res.ok ? { ...row, state: 'stored' } : { ...row, state: res.state });
    });
    controls.append(dl);
  }
  // Keep (DESIGN.md's "mark to keep long term"): the local prune job skips
  // pinned records. Say what the alternative actually costs — once the server
  // has deleted the blob, a pruned copy is gone for good on this device.
  if (row.state === 'stored') {
    const keep = btn(`viewer-toggle${row.keep ? ' viewer-keep-on' : ''}`, 'mediaKeep',
      row.keep ? 'Kept' : 'Keep on this device',
      row.keep ? 'Unpin: this file may be removed from this device after the retention window'
        : 'Pin: keep these bytes on this device past the retention window');
    keep.addEventListener('click', async () => {
      const next = !row.keep;
      await updateMedia(row.id, { keep: next });
      row.keep = next;
      keep.classList.toggle('viewer-keep-on', next);
      keep.replaceChildren(iconEl('mediaKeep'), document.createTextNode(next ? 'Kept' : 'Keep on this device'));
      onChange?.({ ...row });
    });
    controls.append(keep);
  }
  if (controls.children.length) host.append(controls);

  // the ONE teardown: the full-size Blob URLs go when the modal closes (they
  // are the megabytes, and 'bubbles' is a different scope — a re-render must
  // never blank an open viewer, and vice versa)
  return () => {
    releaseScope('viewer');
    host.replaceChildren();
  };
}

function previewStill(row) {
  const img = mk('img', 'viewer-poster');
  img.alt = '';
  img.src = objectUrl(row.thumb, 'viewer');
  return img;
}
