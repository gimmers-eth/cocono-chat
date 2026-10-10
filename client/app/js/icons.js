// Central icon config + helpers (Font Awesome 7 Free, vendored under
// /vendor/fontawesome — MIT/SIL OFL, LICENSE.txt alongside).
//
// EVERY icon in the app comes from this file: static markup carries
// data-icon="<key>" and applyIcons() fills it at boot; dynamic views call
// iconEl(key). No glyph characters live in components anymore, and no
// innerHTML is used anywhere (CSP + the repo's no-innerHTML rule).
//
// FA classes: solid style by default; add 'fa-regular'/'fa-brands' in the
// value when needed (the first token wins the style).

export const ICONS = {
  // chrome / actions
  settings: 'fa-gear',
  logout: 'fa-power-off',
  back: 'fa-arrow-left',
  close: 'fa-xmark',
  send: 'fa-paper-plane',
  menu: 'fa-ellipsis-vertical',
  chat: 'fa-comment',
  share: 'fa-share-nodes',
  shareIos: 'fa-arrow-up-from-bracket', // the iOS Share button itself
  ellipsis: 'fa-ellipsis',              // the ⋯ menu in iOS Safari's bottom bar
  addHome: 'fa-regular fa-square-plus', // 'Add to Home Screen' in the iOS recipe (boxed +, regular style)
  viewMore: 'fa-chevron-down',          // 'View more' row expander in the iOS share sheet

  // message actions
  copy: 'fa-copy',
  forward: 'fa-share',
  delete: 'fa-trash-can',

  // friendship (one-way trust) — sidebar + menu identity marks
  userSolid: 'fa-user',              // you (solid)
  volume: 'fa-volume',                    // chat unmuted (tap to mute)
  volumeXmark: 'fa-volume-xmark',        // chat muted (tap to unmute)
  magnifier: 'fa-magnifying-glass-plus',
  ban: 'fa-ban',
  // block-reason glyphs (iconEl understands two-word 'fa-<style> <name>')
  reasonNospeak: 'fa-regular fa-message',
  reasonUnknown: 'fa-regular fa-circle-question',
  reasonScam: 'fa-solid fa-triangle-exclamation',
  // report action + report-reason glyphs (reports.js)
  report: 'fa-flag',
  reasonHarassment: 'fa-solid fa-comment-slash',
  reasonGraphic: 'fa-regular fa-image',
  volume: 'fa-volume',                    // chat unmuted (tap to mute)
  volumeXmark: 'fa-volume-xmark',        // chat muted (tap to unmute)
  magnifier: 'fa-magnifying-glass-plus',
  ban: 'fa-ban',                    // blocked marker
  userGone: 'fa-user-slash',         // deleted account (red, italic name)
  friend: 'fa-regular fa-user',      // added, not verified (orange)
  friendVerified: 'fa-user-shield',  // shield — ORANGE when only verified,
  trust: 'fa-user-shield',           // GREEN once trusted (top of the ladder)
  notFriend: 'fa-user-xmark',        // stranger marker (red)
  userAdd: 'fa-user-plus',          // action: add user
  friendVerify: 'fa-user-shield',   // action: verify (safety number)
  friendAdd: 'fa-user-shield',      // action: add as friend
  friendRemove: 'fa-user-minus',    // action: remove (red)
  identity: 'fa-fingerprint',       // safety-number panel
  premium: 'fa-certificate',          // PREMIUM gold certificate (was long reserved for exactly this)
  identityAlert: 'fa-circle-exclamation', // peer is NOT identity-verified (red)
  // settings drawer tabs
  tabDevices: 'fa-mobile-screen-button',
  tabVerify: 'fa-id-card',
  tabGeneral: 'fa-sliders',
  tabLimits: 'fa-gauge-high',
  tabDiagnostics: 'fa-heart-pulse',
  tabProfile: 'fa-address-card',
  tabRelationships: 'fa-users',
  profile: 'fa-address-card',       // peer profile panel

  // message status marks
  stateSending: 'fa-clock',
  stateSent: 'fa-check',
  stateDelivered: 'fa-check-double',
  stateFailed: 'fa-circle-exclamation', // + .icon-danger
};

/** <i> element for an ICONS key (returns plain <i> — callers style/label). */
export function iconEl(key, extraClass = '') {
  const name = ICONS[key] ?? key;
  const el = document.createElement('i');
  const style = name.startsWith('fa-regular') || name.startsWith('fa-brands')
    ? name.split(' ')[0] : 'fa-solid';
  const glyph = name.startsWith('fa-') && style !== 'fa-solid' ? name.slice(style.length + 1) : name;
  el.className = `${style} ${glyph}${extraClass ? ` ${extraClass}` : ''}`;
  el.setAttribute('aria-hidden', 'true');
  return el;
}

/** Fill every [data-icon] in the document once (boot-time static markup). */
export function applyIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) {
    if (el.firstElementChild) continue; // idempotent
    el.prepend(iconEl(el.dataset.icon, el.dataset.iconClass ?? ''));
  }
}
