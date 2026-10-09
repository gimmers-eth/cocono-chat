// THE username component — every surface that NAMES a user renders through
// here, so icon/name/badge spacing is one truth everywhere. The metrics are
// copied from the conversation list (the spacing reference):
//   trust icon: .72rem, margin-right .5em, vertical-align .05em
//   name text after the icon; badges/chips follow with margin-left .3em
//   gone → italic name only
//
//   single line:  [trust icon] name [premium] [chip] [unverified-mark]
//   double line:  [avatar?] + stacked( single line, sub )
//
// zoom is an OPTION of the avatar (profile + profile preview pass true;
// chat head and sidebar head pass false — there the photo is decoration,
// not content). PS.BLOCKED (peername.js) flows through as a state like any
// other: the wall mark REPLACES the stranger icon, never stacks.
import { iconEl } from '../icons.js';
import { PS, peerStateIcon, unverifiedBadgeEl, premiumBadgeEl } from './peername.js';
import { openLightbox } from '../ui.js';

/** Children (not a wrapper) for an existing mount — convo rows and simple
    hosts append these directly. */
export function lineKids({ peer, state = null, premium = false, unverified = null, chipEl = null, gone = false }) {
  const kids = [];
  if (state) kids.push(peerStateIcon(state));
  const label = document.createElement('span');
  label.className = 'uname-text';
  label.textContent = peer;
  kids.push(label);
  if (premium) kids.push(premiumBadgeEl());
  if (chipEl) kids.push(chipEl);
  if (unverified === true) kids.push(unverifiedBadgeEl());
  void gone; // handled by the .gone class on the mount (italic .uname-text)
  return kids;
}

/** Paint (or repaint) an element as the single-line username component. */
export function mountLine(el, opts) {
  el.classList.add('uname');
  el.classList.toggle('gone', !!opts.gone || opts.state === PS.GONE);
  el.replaceChildren(...lineKids(opts));
  return el;
}

/** Avatar: photo when present, else initial. With zoom the photo opens the
    lightbox (cursor reflects it). sizeClass keeps per-surface sizing. */
export function avatarStack(name, { src = '', zoom = false, sizeClass = 'avatar' } = {}) {
  const wrap = document.createElement('span');
  // zoom marks the stack HERO: profile surfaces size their avatars a step
  // larger via .avatar-hero (own class, immune to future .avatar overrides)
  wrap.className = `avatar-stack${zoom ? ' avatar-hero' : ''}${zoom && src ? ' zoomable' : ''}`;
  wrap.dataset.zoom = zoom ? '1' : '';
  if (src) {
    const img = document.createElement('img');
    img.className = `avatar avatar-img ${sizeClass}`.trim();
    img.alt = '';
    img.src = src;
    if (zoom) img.addEventListener('click', () => openLightbox(src));
    wrap.append(img);
    if (zoom) {
      // visible affordance: a magnifier corner badge whenever a PHOTO (not
      // the initial) can actually be enlarged — profile sheets & previews
      const hint = iconEl('magnifier', 'avatar-zoom-hint');
      hint.setAttribute('aria-hidden', 'true');
      wrap.append(hint);
    }
  } else {
    const span = document.createElement('span');
    span.className = `avatar ${sizeClass}`.trim();
    span.setAttribute('aria-hidden', 'true');
    span.textContent = String(name ?? '?').slice(0, 1);
    wrap.append(span);
  }
  return wrap;
}

/** Re-render an avatar mount (paint-on-place: keeps the wrapper element). */
export function setAvatar(mountEl, name, opts = {}) {
  const fresh = avatarStack(name, opts);
  mountEl.className = fresh.className;
  mountEl.dataset.zoom = opts.zoom ? '1' : '';
  mountEl.replaceChildren(...fresh.childNodes);
  return mountEl;
}

/** Single line + optional sub line, with optional leading avatar. */
export function doubleLine({
  peer, avatar = null, avatarSrc = '', zoom = false, sizeClass = 'avatar',
  sub = null, line = {},
}) {
  const wrap = document.createElement('span');
  wrap.className = 'udouble';
  if (avatar) wrap.append(avatar);
  else if (avatarSrc || !line.hideInitial) wrap.append(avatarStack(peer, { src: avatarSrc, zoom, sizeClass }));
  const meta = document.createElement('span');
  meta.className = 'udouble-meta';
  meta.append(mountLine(document.createElement('span'), { peer, ...line }));
  if (sub) meta.append(sub);
  wrap.append(meta);
  return wrap;
}

/** The identity sub line: green shield-person + "Verified". Sits UNDER the
    name wherever identity verification is a fact about that account. */
export function verifiedSubEl(text = 'Verified') {
  const span = document.createElement('span');
  span.className = 'user-verified-sub';
  span.append(iconEl('friendVerified', 'icon-friend'), document.createTextNode(` ${text}`));
  return span;
}
