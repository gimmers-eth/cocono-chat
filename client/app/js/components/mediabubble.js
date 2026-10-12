// Media bubbles (M4, req 3) — what one image/video/file looks like INSIDE the
// transcript. chat.js owns the <li> (direction class, timestamp, delivery
// ticks) and its re-render loop; this module owns the CONTENT of a media
// bubble and nothing else, so the two never fight over the same node.
//
// Two rules that are easy to get wrong and are encoded here:
//  * A bubble shows the THUMBNAIL (256 px, made by the sender, decrypted with
//    the file key) whenever one exists — never the multi-megabyte full image
//    — because render() rebuilds these nodes on every event. The full bytes
//    belong to the viewer (mediaview.js).
//  * Every URL here comes from objectUrl(blob, 'bubbles'); chat.js releases
//    that scope before each re-render. The viewer's URLs are a different
//    scope, so a re-render can never blank an open viewer.

import { iconEl } from '../icons.js';
import { formatSize, objectUrl, isBlurred, durationText, renderableAsImage, hasLocalBytes } from '../media.js';

const KIND_ICON = { image: 'tabImages', video: 'tabVideos', file: 'attachFile' };

// States in which the bytes on this device ARE the ones the row points at: the
// sender's own copy from the moment it is picked ('preparing'), through the
// upload ('uploading'), to the settled row ('stored'). A draft is worth a real
// preview — the user is looking at it while the phone works.
const HAS_OWN_BYTES = new Set(['stored', 'uploading', 'preparing']);

const mk = (tag, cls, text) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined && text !== null) el.textContent = text;
  return el;
};

// What the BYTES are doing right now (distinct from the delivery ticks on the
// timestamp row, which are about the MESSAGE).
const STATUS = {
  pending:     { image: 'Photo', video: 'Video', file: 'Tap download' },
  synced:      { image: 'Photo', video: 'Video', file: 'Tap download' },
  // while it is in flight the percentage IS the message: 'downloading…' with no
  // number is what makes a 100 MB fetch look stuck
  downloading: { image: 'Downloading…', video: 'Downloading…', file: 'Downloading…' },
  // the OUTGOING half of the same idea. Preparing (reading the file, cutting a
  // poster, re-encoding if that is switched on) and uploading are phases of the
  // MESSAGE, and they belong in the bubble the user is looking at — a toast
  // expires after 4.5 s and a phone that works for 30 s looks frozen.
  preparing:   { image: 'Preparing…', video: 'Preparing video…', file: 'Preparing…' },
  uploading:   { image: 'Uploading…', video: 'Uploading…', file: 'Uploading…' },
  declined:    { image: 'Removed from this device', video: 'Removed from this device', file: 'Deleted — not downloaded' },
  expired:     { image: 'No longer available', video: 'No longer available', file: 'No longer available' },
  failed:      { image: 'Download failed', video: 'Download failed', file: 'Download failed' },
  // 'pruned' splits on WHY the record says it is (prunedWhy): a copy the phone
  // already owns is not a loss, and the thumbnail that stays on the wall is a
  // preview, not the file.
  pruned:      { image: '', video: '', file: '' },
};

/** States whose bubble carries a determinate bar (bytes moving in OR out). */
export const PROGRESS_STATES = ['downloading', 'preparing', 'uploading'];
export const hasProgress = (row) => PROGRESS_STATES.includes(row?.state);

function statusLine(row) {
  if (row?.state === 'pruned') {
    // the honest sentence needs the reason the sweep recorded when it dropped
    // the bytes — 'Removed from this device' over something the user saved
    // reads like the app lost their file
    const saved = row.prunedWhy === 'saved';
    const text = saved
      ? (row.kind === 'file' ? 'Saved to your phone' : 'Saved to your phone · preview only here')
      : 'Removed from this device';
    return mk('span', 'media-status', text);
  }
  const t = STATUS[row?.state]?.[row?.kind];
  return t ? mk('span', 'media-status', t) : null;
}

/** Preview picture: thumb when present, else the decrypted bytes (a send
 *  without a poster, or an image that could not be thumbnailed). */
function previewEl(row, blur) {
  // A VIDEO this device holds is always a <video>, poster or not: the badge on
  // top of it plays the clip IN PLACE (chat.js owns the tap), which an <img>
  // cannot do. With a poster the element costs nothing to paint (`preload:none`
  // shows the JPEG and decodes only on play); without one it decodes frame 0.1 s
  // so the bubble is a picture rather than a black box.
  if (row.kind === 'video') {
    if (hasLocalBytes(row)) return videoPreviewEl(row);
    const thumb = row.thumb;
    if (thumb?.size && (!thumb.type || thumb.type.startsWith('image/'))) return imgPreviewEl(thumb, row, blur);
    return null;
  }
  // A picture, or nothing. The fallback used to reach for `row.data` on any
  // stored row, which for a VIDEO meant handing MP4 bytes to an <img> — the
  // engine paints a broken/looping frame instead of a preview.
  const blob = row.thumb ?? (renderableAsImage(row) && HAS_OWN_BYTES.has(row.state) ? row.data : null);
  if (blob && blob.size && (!blob.type || blob.type.startsWith('image/'))) return imgPreviewEl(blob, row, blur);
  return null;
}

function imgPreviewEl(blob, row, blur) {
  const img = mk('img', `media-thumb media-${row.kind}${blur ? ' is-blurred' : ''}`);
  img.alt = '';
  img.decoding = 'async';
  img.src = objectUrl(blob, 'bubbles');
  return img;
}

/**
 * The clip itself, as a paused, control-less <video> that the badge on top of
 * it can play IN PLACE. Two loading shapes, because a re-render must not decode
 * a whole conversation of video:
 *   - with a poster: `preload='none'` + the `poster` attribute. The JPEG is what
 *     paints, nothing is decoded until someone presses play.
 *   - without one: `preload='metadata'` and a `#t=0.1` media fragment, which is
 *     what makes an engine decode a frame instead of showing a black box.
 * Nothing here may start by itself (no autoplay, no loop, no controls): sound
 * and playback are a person's decision, and the message modal is the other
 * place this clip can be played.
 */
function videoPreviewEl(row) {
  const v = mk('video', 'media-thumb media-video');
  v.muted = true;
  v.setAttribute?.('muted', '');
  v.playsInline = true;
  v.setAttribute?.('playsinline', '');
  v.controls = false;
  v.autoplay = false;
  v.loop = false;
  const url = objectUrl(row.data, 'bubbles');
  if (row.thumb?.size) {
    v.poster = objectUrl(row.thumb, 'bubbles');
    v.preload = 'none';
    v.src = url;
  } else {
    v.preload = 'metadata';
    v.src = `${url}#t=0.1`;
  }
  v.dataset.mediaId = String(row.id ?? '');   // chat.js resumes it across a re-render
  return v;
}

/** Wrap the shot + its overlays in one positioned box (the bubble itself must
 *  not become the containing block for a play badge). */
function shot(row, blur, playing = false) {
  const pic = previewEl(row, blur);
  if (!pic) return null;
  const box = mk('span', 'media-shot');
  box.append(pic);
  if (row.kind === 'video') {
    // A BUTTON when there is something to play: the badge plays the clip IN THE
    // MESSAGE (chat.js binds it by class), and the rest of the bubble still
    // opens the modal. Purely decorative — a `<span>` a tap falls through — when
    // this device does not hold the bytes.
    const playable = pic.tagName === 'VIDEO';
    const badge = mk(playable ? 'button' : 'span', `media-play-badge${playing ? ' is-playing' : ''}`);
    if (playable) {
      badge.type = 'button';
      badge.dataset.act = 'playpause';
      badge.title = playing ? 'Pause this video' : 'Play this video here';
      badge.setAttribute?.('aria-label', playing ? 'Pause the video in this message' : 'Play the video in this message');
    }
    badge.append(iconEl(playing ? 'mediaPause' : 'mediaPlay'));
    box.append(badge);
    if (playable) {
      // the badge is the element's own transport: whatever else starts or stops
      // the clip (a re-render, the end of the file, another tap) has to be
      // reflected there, or the button lies about what it will do next
      pic.addEventListener?.('play', () => paintBadge(badge, true));
      pic.addEventListener?.('pause', () => paintBadge(badge, false));
      pic.addEventListener?.('ended', () => paintBadge(badge, false));
    }
    if (row.dur) box.append(mk('span', 'media-duration', durationText(row.dur)));
  }
  if (blur) {
    const hint = mk('span', 'media-blur-hint');
    hint.append(iconEl('mediaUnblur'), document.createTextNode(' tap to view'));
    box.append(hint);
  }
  // A clip THIS ENGINE cannot decode (HEVC/.mov on Chromium is the common case)
  // fires `error` on the element and would otherwise sit there as a black box.
  // Swap in the labelled tile: the honest 'a video, N MB, not playable here'.
  if (pic.tagName === 'VIDEO') {
    pic.addEventListener?.('error', () => { box.replaceChildren(plainTile(row, 'mediaUndecodable')); }, { once: true });
  }
  return box;
}

/** The badge's glyph says what the NEXT tap does: pause while it plays. */
function paintBadge(badge, playing) {
  try {
    badge.replaceChildren(iconEl(playing ? 'mediaPause' : 'mediaPlay'));
    badge.classList?.toggle?.('is-playing', !!playing);
    badge.title = playing ? 'Pause this video' : 'Play this video here';
  } catch { /* a badge that cannot repaint is not worth a thrown render */ }
}

/** The labelled tile: what a bubble shows when there are no pixels to show.
 *  A name, a size and (for a clip) a duration read as 'a video, not fetched
 *  yet'; a bare glyph reads as 'broken'. */
function plainTile(row, icon = null) {
  const tile = mk('span', 'media-plain');
  tile.append(iconEl(icon ?? (row.state === 'expired' ? 'mediaExpired' : (KIND_ICON[row.kind] ?? 'attachFile'))));
  const meta = mk('span', 'media-plain-meta');
  meta.append(mk('span', 'media-plain-name', row.name || (row.kind === 'video' ? 'Video' : 'Attachment')));
  const sub = [
    row.size ? formatSize(row.size) : null,
    row.kind === 'video' && row.dur ? durationText(row.dur) : null,
  ].filter(Boolean).join(' · ');
  if (sub) meta.append(mk('span', 'media-plain-sub', sub));
  tile.append(meta);
  return tile;
}

/**
 * Nodes to append INSIDE an existing li.msg for a media message.
 * `verified` is the SENDER's admin identity-verified flag (blur policy, req 7)
 * — 'out' rows are never blurred regardless (isBlurred owns that rule).
 */
export function bubbleNodes(msg, row, { verified = false, playing = false } = {}) {
  // an outgoing send still in flight: the work IS the status. A draft row
  // (written the moment the file is picked) carries preparing/uploading and its
  // progress, so the bubble shows the bar instead of a toast that expires.
  if (msg.dir === 'out' && msg.state === 'sending' && (!row || (!row.data && !hasProgress(row)))) {
    return [iconEl('attachFile', 'media-gone-ic'), mk('span', 'media-status', 'Uploading…')];
  }
  if (!row) {
    // the transcript says media, this device has no record: synced before
    // this device existed, or the user removed the row
    return [
      mk('span', 'media-name', msg.kind === 'file' ? 'File' : 'Photo or video'),
      mk('span', 'media-status', 'Not on this device'),
    ];
  }

  const nodes = [];
  // a file, or an 'image' that refuses to be a picture (see renderableAsImage);
  // a video still gets its poster + play badge below
  if (row.kind === 'file' || (row.kind === 'image' && !renderableAsImage(row))) {
    const wrap = mk('span', 'media-file');
    const ic = mk('span', 'media-file-icon');
    ic.append(iconEl(KIND_ICON.file));
    const meta = mk('span', 'media-file-meta');
    meta.append(mk('span', 'media-file-name', row.name || 'attachment'));
    meta.append(mk('span', 'media-file-size', formatSize(row.size)));
    wrap.append(ic, meta);
    nodes.push(wrap);   // name + size are the whole content of a file bubble
  } else {
    const box = shot(row, renderableAsImage(row) && isBlurred(row, verified), playing);
    if (box) {
      nodes.push(box);
      if (row.name) nodes.push(mk('span', 'media-name', row.name));
    } else {
      // Nothing to preview — the sender's browser could not capture a frame and
      // this device does not hold the bytes (or cannot decode them). Say WHAT it
      // is rather than dropping a lone glyph in the thread.
      nodes.push(plainTile(row));
    }
  }

  const status = statusLine(row);
  if (status) nodes.push(status);
  // a determinate bar while bytes are moving — in OR out. When a previous
  // session stopped mid-fetch, say where it stopped: that is what makes 'it
  // resumes' visible
  if (hasProgress(row) || (row.partialBytes > 0 && row.state === 'failed')) {
    const pct = Math.max(0, Math.min(1, Number(row.progress) || 0));
    const bar = mk('span', 'media-progress');
    const fill = mk('span', 'media-progress-fill');
    fill.style.width = `${Math.round(pct * 100)}%`;
    bar.append(fill);
    nodes.push(bar);
    if (row.state === 'failed' && row.partialBytes > 0) {
      nodes.push(mk('span', 'media-status', `${formatSize(row.partialBytes)} received — it continues from there`));
    }
  }

  // pending / failed video|file: the two choices req 6 puts IN the bubble
  // (chat.js binds them by class on its delegated listener)
  const acts = mk('span', 'media-actions');
  if (row.state === 'pending' || row.state === 'synced' || row.state === 'failed') {    const dl = mk('button', 'media-dl');
    dl.type = 'button';
    dl.append(iconEl('mediaDownload'), document.createTextNode(` Download${row.size ? ` (${formatSize(row.size)})` : ''}`));
    acts.append(dl);
  }
  // a FILE that is on this device gets its save right here: opening the modal
  // to reach the same button is a fine second route, but a file you cannot
  // hand to another app has not arrived (req 3/6)
  if (row.kind === 'file' && hasLocalBytes(row)) {
    const sv = mk('button', 'media-save');
    sv.type = 'button';
    sv.title = 'Save this file, or open it in another app';
    sv.append(iconEl('mediaSave'), document.createTextNode(' Save to device'));
    acts.append(sv);
  }
  if ((row.state === 'pending' || row.state === 'synced' || row.state === 'failed') && row.kind === 'file') {
    const dec = mk('button', 'media-decline');
    dec.type = 'button';
    dec.append(iconEl('delete'), document.createTextNode(' Delete'));
    dec.title = 'Delete without downloading — marks it received on this device';
    acts.append(dec);
  }
  if (acts.childNodes.length) nodes.push(acts);
  return nodes;
}
