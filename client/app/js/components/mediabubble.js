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
  declined:    { image: 'Removed from this device', video: 'Removed from this device', file: 'Deleted — not downloaded' },
  expired:     { image: 'No longer available', video: 'No longer available', file: 'No longer available' },
  failed:      { image: 'Download failed', video: 'Download failed', file: 'Download failed' },
  // 'pruned' splits on WHY the record says it is (prunedWhy): a copy the phone
  // already owns is not a loss, and the thumbnail that stays on the wall is a
  // preview, not the file.
  pruned:      { image: '', video: '', file: '' },
};

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
  // A picture, or nothing. The fallback used to reach for `row.data` on any
  // stored row, which for a VIDEO meant handing MP4 bytes to an <img> — the
  // engine paints a broken/looping frame instead of a preview. A video with no
  // poster shows the film icon (and the recipient side generates its own
  // first-frame poster, media.js buildPoster, once the bytes land).
  const blob = row.thumb ?? (renderableAsImage(row) && row.state === 'stored' ? row.data : null);
  if (!blob || !blob.size) return null;
  if (blob.type && !blob.type.startsWith('image/')) return null;
  const img = mk('img', `media-thumb media-${row.kind}${blur ? ' is-blurred' : ''}`);
  img.alt = '';
  img.decoding = 'async';
  img.src = objectUrl(blob, 'bubbles');
  return img;
}

/** Wrap the shot + its overlays in one positioned box (the bubble itself must
 *  not become the containing block for a play badge). */
function shot(row, blur) {
  const pic = previewEl(row, blur);
  if (!pic) return null;
  const box = mk('span', 'media-shot');
  box.append(pic);
  if (row.kind === 'video') {
    const badge = mk('span', 'media-play-badge');
    badge.append(iconEl('mediaPlay'));
    box.append(badge);
    if (row.dur) box.append(mk('span', 'media-duration', durationText(row.dur)));
  }
  if (blur) {
    const hint = mk('span', 'media-blur-hint');
    hint.append(iconEl('mediaUnblur'), document.createTextNode(' tap to view'));
    box.append(hint);
  }
  return box;
}

/**
 * Nodes to append INSIDE an existing li.msg for a media message.
 * `verified` is the SENDER's admin identity-verified flag (blur policy, req 7)
 * — 'out' rows are never blurred regardless (isBlurred owns that rule).
 */
export function bubbleNodes(msg, row, { verified = false } = {}) {
  // an outgoing send still in flight: the upload IS the status (a media
  // message that has not been acked has no bytes on the server yet)
  if (msg.dir === 'out' && msg.state === 'sending' && (!row || !row.data)) {
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
    const box = shot(row, renderableAsImage(row) && isBlurred(row, verified));
    if (box) nodes.push(box);
    // nothing to preview (never fetched, declined, aged out, or gone from the
    // server): the KIND glyph for a file we still own, the question mark for
    // bytes nobody can bring back
    else nodes.push(iconEl(row.state === 'expired' ? 'mediaExpired' : (KIND_ICON[row.kind] ?? 'attachFile'), 'media-gone-ic'));
    if (row.name) nodes.push(mk('span', 'media-name', row.name));
  }

  const status = statusLine(row);
  if (status) nodes.push(status);
  // a determinate bar while bytes are moving; when a previous session stopped
  // mid-fetch, say where it stopped — that is what makes 'it resumes' visible
  if (row.state === 'downloading' || (row.partialBytes > 0 && row.state === 'failed')) {
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
  if (row.state === 'pending' || row.state === 'synced' || row.state === 'failed') {
    const dl = mk('button', 'media-dl');
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
