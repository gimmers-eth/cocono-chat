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
import { logEvent } from '../applog.js';
import { openLightbox, closeLightbox } from '../ui.js';
import { mediaWith, messagesWith, updateMedia } from '../store.js';
import {
  formatSize, durationText, isBlurred, objectUrl, releaseScope, filterMedia,
  tabBuckets, downloadMedia, declineMedia, renderableAsImage,
  saveToDevice, shareToDevice, hasLocalBytes,
} from '../media.js';

// exported so chat.js and the tests agree on the vocabulary
export const TABS = ['chat', 'images', 'videos', 'files', 'links'];

/** How many poster-less clips may hold a media element just to paint a frame. */
const WALL_VIDEO_MAX = 4;
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

function tile(row, { blur, caption, onOpen, videoPreview = false }) {
  const t = mk('button', `media-tile ${dirClass(row)}`);
  t.type = 'button';
  const pic = row.thumb ?? (row.kind === 'image' ? row.data : null);
  if (pic && pic.size) {
    const img = mk('img', `media-tile-img${blur ? ' is-blurred' : ''}`);
    img.alt = '';
    img.decoding = 'async';
    img.src = objectUrl(pic, 'bubbles');
    t.append(img);
  } else if (row.kind === 'video' && videoPreview && hasLocalBytes(row)) {
    // No poster, but the bytes are on this device: let the engine paint frame
    // one itself (`#t=0.1` is what makes it seek instead of showing black). The
    // wall would otherwise be a grid of film glyphs for every clip whose sender
    // could not cut a preview.
    const v = mk('video', 'media-tile-img media-tile-video');
    v.muted = true;
    v.setAttribute?.('muted', '');
    v.playsInline = true;
    v.setAttribute?.('playsinline', '');
    v.controls = false;
    v.autoplay = false;
    v.loop = false;
    v.preload = 'metadata';
    v.setAttribute?.('tabindex', '-1');
    v.src = `${objectUrl(row.data, 'bubbles')}#t=0.1`;
    // an engine that cannot decode it (HEVC on Chromium) must not leave a black
    // square: fall back to the glyph the tile would have had
    v.addEventListener?.('error', () => {
      const parent = v.parentNode;
      if (!parent) return;
      const ic = mk('span', 'media-tile-icon');
      ic.append(iconEl('tabVideos'));
      parent.insertBefore(ic, v);
      v.remove?.();
    }, { once: true });
    t.append(v);
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
  // ONE button per row, saying what it actually does: pull the bytes here
  // (pending) vs hand them to the device (stored). Never both, and never a
  // 'Download' that only fetches into the app's own store.
  const pending = row.state === 'pending' || row.state === 'synced' || row.state === 'failed';
  if (pending || hasLocalBytes(row)) {
    const act = btn('media-line-dl', pending ? 'mediaDownload' : 'mediaSave', null,
      pending ? 'Download to this device' : 'Save to the device / open in another app');
    act.addEventListener('click', (e) => {
      e.stopPropagation();               // the row itself opens the viewer
      onAction?.(row, pending ? 'download' : 'save');
    });
    b.append(act);
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
    // The same decoder budget as the transcript: a wall of poster-less clips must
    // not become a wall of media elements (a phone runs out, and the element that
    // then fails is someone's message modal). Posters are free; elements are not.
    let videoBudget = WALL_VIDEO_MAX;
    for (const row of list) {
      const needsElement = row.kind === 'video' && !row.thumb?.size && hasLocalBytes(row);
      wall.append(tile(row, {
        // req 7: an unverified SENDER's image is blurred by default, and the
        // record's own toggle (row.blurred) wins — same rule as the transcript
        blur: tab === 'images' && isBlurred(row, verified),
        caption: row.kind === 'video' && row.dur ? durationText(row.dur) : null,
        videoPreview: needsElement && videoBudget-- > 0,
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

/** A media row's bubble/row actions, shared by the transcript and the Files tab
 *  so both do exactly the same thing. `save` reports the outcome through
 *  onDone because it leaves the app's sandbox — the user has to be told which
 *  door it went out of (or that they dismissed it). */
export async function mediaAction(client, row, action, { onDone } = {}) {
  if (!row) return;
  if (action === 'download') await downloadMedia(client, row);
  else if (action === 'decline') await declineMedia(client, row);
  else if (action === 'save') { onDone?.(await saveToDevice(row)); return; }
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

  // What may be SHOWN, by kind. A picture can be displayed from its poster;
  // a video needs its real bytes — feeding <video> the JPEG poster made it load
  // and then fail the moment play() was pressed, which is the other half of
  // 'this video could not be played here'. A file has no picture at all.
  const full = shape === 'video' ? (row.data ?? null)
    : shape === 'image' ? (row.data ?? row.thumb ?? null) : null;
  if (shape === 'file') {
    const card = mk('div', 'viewer-file');
    const ic = mk('span', 'viewer-file-icon');
    ic.append(iconEl('attachFile'));
    card.append(ic);
    card.append(mk('p', 'viewer-file-name', row.name || 'attachment'));
    card.append(mk('p', 'muted small', `${formatSize(row.size)} · ${new Date(row.ts).toLocaleString()}`));
    if (row.state === 'expired') card.append(mk('p', 'media-status', 'No longer available on the server.'));
    if (row.state === 'pruned') card.append(mk('p', 'media-status',
      row.prunedWhy === 'saved' ? 'Saved to your phone — this copy is no longer kept in the app.'
        : 'Removed from this device to save space.'));
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
      // `#t=0.1` makes the engine seek (and therefore DECODE) a frame instead of
      // leaving a black rectangle until Play is pressed — a modal that opens on
      // black reads as 'the video is broken'. The bytes are already local, so
      // 'auto' costs no network.
      video.src = `${url}#t=0.1`;
      video.playsInline = true;   // NO native controls: the row below is ours
      video.preload = 'auto';
      // Stated explicitly because a video that 'constantly loops' was the
      // report: nothing in here may start by itself. A phone that just spent
      // mobile data fetching this file does not want it playing on open, and
      // `loop` on a chat attachment is never intended.
      video.autoplay = false;
      video.loop = false;
      video.controls = false;
      if (row.thumb && row.thumb.size) video.poster = objectUrl(row.thumb, 'viewer');
      const play = btn('viewer-toggle', 'mediaPlay', 'Play', 'Play this video');
      play.addEventListener('click', () => {
        if (video.paused) {
          video.play().catch(() => {
            // Named, because 'could not be played here' is a dead end and this
            // one has a way out: a phone recording is very often HEVC/.mov,
            // which Safari plays and Chromium on the same machine may not. The
            // file is intact — it is this element that cannot decode it, so
            // Save-to-device and open it in a video app is the honest answer
            // until we transcode on the way up (WebCodecs + an mp4 muxer: a
            // dependency decision, not a bug fix).
            status('This browser cannot decode that video (phone cameras often record HEVC/.mov). It is downloaded intact — Save to device and open it in your video app.', true);
          });
        } else video.pause();
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
      // Say it BEFORE the user presses Play and gets nothing: an engine that
      // cannot decode this codec (HEVC/.mov on Chromium) fires `error` on load.
      // The CODE is the part that means anything, so it is journalled and said:
      // 3 is the decoder giving up on these bytes, 4 is the source being refused
      // — which is also what a phone reports when it has run out of media
      // elements. Guessing 'codec' at a 4 is what sent us re-encoding clips that
      // were perfectly fine.
      video.addEventListener('error', () => {
        const code = video.error?.code ?? '?';
        logEvent('media', `viewer cannot play video code=${code}`);
        status(code === 3
          ? 'This browser cannot decode that video (phone cameras often record HEVC/.mov). It is intact — Save to device and open it in your video app.'
          : `This browser would not play that video (media error ${code}). Close and open it again, or Save to device and use your video app.`, true);
      }, { once: true });
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
    // 'pruned' is NOT 'expired': the local retention job dropped bytes this
    // device already had, and only the server knows whether a copy is still
    // there (another device may still owe an ack). So that case OFFERS the
    // attempt and lets the answer speak — a refused download is a fact, a
    // guessed one is a lie. 'expired'/'declined' are settled: nothing to ask.
    const retry = row.state === 'pruned';
    const settled = row.state === 'expired' || row.state === 'declined';
    const dl = btn('viewer-toggle', 'mediaDownload',
      retry ? 'Download again' : settled ? 'Cannot be downloaded' : 'Download',
      retry ? 'Fetch it again — if the server still holds a copy' : 'Download the full file to this device');
    dl.disabled = settled;
    dl.title = settled
      ? 'The server no longer holds this file — it cannot be downloaded again.'
      : dl.title;
    dl.addEventListener('click', async () => {
      dl.disabled = true;
      status('Downloading…');
      // Percentages, not a spinner: at 100 MB on mobile data 'downloading' for
      // four minutes with no number is indistinguishable from a hang. Throttled
      // to whole percents because status() is a text node, not a bar.
      let lastPct = -1;
      const res = await downloadMedia(client, row, {
        onProgress: (got, total) => {
          const pct = total ? Math.floor((got / total) * 100) : 0;
          if (pct !== lastPct) {
            lastPct = pct;
            status(total ? `Downloading ${pct}% (${formatSize(got)} of ${formatSize(total)})` : `Downloading ${formatSize(got)}…`);
          }
        },
      });
      status(res.ok ? 'Downloaded ✓' : res.state === 'expired' ? 'No longer available on the server.' : 'Download failed — try again later.', !res.ok);
      onChange?.(res.ok ? { ...row, state: 'stored' } : { ...row, state: res.state });
    });
    controls.append(dl);
  }
  // ---- the way OUT: this device's bytes into the user's hands ----
  // The viewer is where a photo is actually LOOKED at and where a file gets
  // opened, so this is where saving belongs; the bubbles stay quiet.
  if (isImage) {
    const expand = btn('viewer-toggle', 'mediaExpand', 'Expand', 'View full size');
    expand.addEventListener('click', () => {
      const img = host.querySelector('.viewer-image');
      if (img?.src) openLightbox(img.src, { round: false });
    });
    controls.append(expand);
  }
  if (hasLocalBytes(row)) {
    // SAVE IS A DOWNLOAD. It used to open the Web Share sheet first, which on a
    // phone is a chooser, not a result — 'Save' that leaves the file nowhere
    // visible is worse than no button. Share survives only as the explicit
    // fallback this reveals if (and only if) the engine refuses to download
    // (iOS in an installed PWA is that case), so the user is never asked to
    // pick between two words for the same thing.
    const save = btn('viewer-toggle', 'mediaSave', 'Save to device',
      row.kind === 'file' ? 'Download this file to the phone'
        : row.kind === 'video' ? 'Download this video to the phone'
          : 'Download this photo to the phone');
    save.addEventListener('click', async () => {
      save.disabled = true;
      const res = await saveToDevice(row);
      save.disabled = false;
      if (res.ok) {
        status(`Saved as ${res.name} — open it from your Files/Downloads app.`);
        // the stamp is the point: it tells the retention job this copy is now
        // a duplicate of something the person owns
        onChange?.({ ...row, savedAt: Date.now() });
        return;
      }
      if (res.how === 'unsupported') {
        logEvent('save', 'this engine refuses downloads; share fallback offered');
        status('This browser blocks in-app downloads — use Share to put it in Files, or open it in another app.', true);
        const share = btn('viewer-toggle', 'mediaShare', 'Share instead', 'Save via the share sheet');
        share.addEventListener('click', async () => {
          const sres = await shareToDevice(row);
          if (sres.ok) { status('Shared — choose “Save to Files”.'); onChange?.({ ...row, savedAt: Date.now() }); }
          else if (sres.how === 'cancelled') status('Share cancelled.');
          else status('No save route works in this browser.', true);
        });
        controls.append(share);
        return;
      }
      status(res.how === 'cancelled' ? 'Save cancelled.' : 'The save did not start — try again.', true);
    });
    controls.append(save);
  }
  // There is no 'Keep on this device' pin any more, deliberately. Two things
  // replaced it: saving the file makes the PHONE the owner (so the app may
  // release its duplicate — prune rule 2), and the retention window covers
  // everything else. A pin only ever grew a pile of data nobody could see,
  // clean or name, and its label was indistinguishable from Save's.

  if (controls.children.length) host.append(controls);

  // the ONE teardown: the full-size Blob URLs go when the modal closes (they
  // are the megabytes, and 'bubbles' is a different scope — a re-render must
  // never blank an open viewer, and vice versa). Any Expand overlay goes with
  // it: the lightbox shows the SAME URL, so leaving it open would point at a
  // revoked Blob.
  return () => {
    closeLightbox();
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
