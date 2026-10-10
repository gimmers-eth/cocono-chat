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
import { formatSize, objectUrl, isBlurred, durationText } from '../media.js';

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
  downloading: { image: 'Downloading…', video: 'Downloading…', file: 'Downloading…' },
  declined:    { image: 'Removed from this device', video: 'Removed from this device', file: 'Deleted — not downloaded' },
  expired:     { image: 'No longer available', video: 'No longer available', file: 'No longer available' },
  failed:      { image: 'Download failed', video: 'Download failed', file: 'Download failed' },
  pruned:      { image: 'Removed from this device', video: 'Removed from this device', file: 'Removed from this device' },
};

function statusLine(row) {
  const t = STATUS[row?.state]?.[row?.kind];
  return t ? mk('span', 'media-status', t) : null;
}

/** Preview picture: thumb when present, else the decrypted bytes (a send
 *  without a poster, or an image that could not be thumbnailed). */
function previewEl(row, blur) {
  const blob = row.thumb ?? (row.state === 'stored' ? row.data : null);
  if (!blob || !blob.size) return null;
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
  if (row.kind === 'file') {
    const wrap = mk('span', 'media-file');
    const ic = mk('span', 'media-file-icon');
    ic.append(iconEl(KIND_ICON.file));
    const meta = mk('span', 'media-file-meta');
    meta.append(mk('span', 'media-file-name', row.name || 'attachment'));
    meta.append(mk('span', 'media-file-size', formatSize(row.size)));
    wrap.append(ic, meta);
    nodes.push(wrap);   // name + size are the whole content of a file bubble
  } else {
    const box = shot(row, row.kind === 'image' && isBlurred(row, verified));
    if (box) nodes.push(box);
    else nodes.push(iconEl(KIND_ICON[row.kind] ?? 'attachFile', 'media-gone-ic'));
    if (row.name) nodes.push(mk('span', 'media-name', row.name));
  }

  const status = statusLine(row);
  if (status) nodes.push(status);

  // pending / failed video|file: the two choices req 6 puts IN the bubble
  // (chat.js binds both by class on its delegated listener)
  if (row.state === 'pending' || row.state === 'synced' || row.state === 'failed') {
    const acts = mk('span', 'media-actions');
    const dl = mk('button', 'media-dl');
    dl.type = 'button';
    dl.append(iconEl('mediaDownload'), document.createTextNode(` Download${row.size ? ` (${formatSize(row.size)})` : ''}`));
    acts.append(dl);
    if (row.kind === 'file') {
      const dec = mk('button', 'media-decline');
      dec.type = 'button';
      dec.append(iconEl('delete'), document.createTextNode(' Delete'));
      dec.title = 'Delete without downloading — marks it received on this device';
      acts.append(dec);
    }
    nodes.push(acts);
  }
  return nodes;
}
