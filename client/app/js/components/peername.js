// THE single component for rendering a username with its trust icon.
// Every surface (sidebar, chat header, chat-options title) goes through
// resolvePeerState + peerStateIcon/peerTagEl — one place to keep the
// ladder consistent:
//
//   self        solid user          (neutral)
//   stranger    user-xmark          RED      — not added / conflict
//   added       outlined user       ORANGE   — added, not verified
//   verified    shield user         ORANGE   — safety number confirmed
//   trusted     shield user         GREEN    — "I know this person" (max)
//   gone        user-slash + italic RED      — account deleted (outranks all)
//
// A local pin CONFLICT (server binding disagrees with our pinned key) maps
// to stranger for display; the chat strip carries the detailed alert.

import { iconEl } from '../icons.js';

export const PS = {
  SELF: 'self',
  STRANGER: 'stranger',
  UNVERIFIED: 'unverified',
  VERIFIED: 'verified',
  TRUSTED: 'trusted',
  GONE: 'gone',

  // pseudo-state: MY OWN block (see peerStateIcon) — replaces the stranger
  // mark wherever the surface knows the wall exists
  BLOCKED: 'blocked',
};

/**
 * @param {object} f
 * @param {boolean} f.isSelf     the peer is the logged-in account itself
 * @param {boolean} f.gone       account deleted (server flag or 404 ghost)
 * @param {boolean} f.bound      added friend (key stamped + matching)
 * @param {boolean} f.verified   safety number explicitly compared & confirmed
 * @param {boolean} f.trusted    third stage: "I know this person"
 * @param {boolean} f.conflict   local pin disagrees with the binding (alarm)
 */
export function resolvePeerState({
  isSelf = false, gone = false, bound = false, verified = false, trusted = false, conflict = false,
} = {}) {
  if (isSelf) return PS.SELF;
  if (gone) return PS.GONE;
  if (conflict || !bound) return PS.STRANGER;
  if (!verified) return PS.UNVERIFIED;
  return trusted ? PS.TRUSTED : PS.VERIFIED;
}

const MARKS = {
  [PS.SELF]: ['userSolid', ''],
  [PS.GONE]: ['userGone', 'icon-danger'],
  [PS.STRANGER]: ['notFriend', 'icon-danger'],
  [PS.UNVERIFIED]: ['friend', 'icon-warn'],
  [PS.VERIFIED]: ['friendVerified', 'icon-warn'],
  [PS.TRUSTED]: ['friendVerified', 'icon-friend'],
};

/** <i> element carrying the state icon. */
/**
 * THE ONE RENDER CHOKE-POINT for peer trust icons.
 *
 * PS.BLOCKED is a pseudo-state (not part of resolvePeerState's ladder):
 * blocking severs the friends relation both ways, so trustState() can only
 * ever say STRANGER about a blocked peer — the wall itself lives on YOUR
 * account (the blocked mirror). Any surface that knows the peer is blocked
 * passes PS.BLOCKED instead, and gets a distinct trust icon that REPLACES
 * the stranger mark everywhere (sidebar rows, profile sheets, chat head,
 * options menu, safety view) — never a second badge stacked next to it.
 */
export function peerStateIcon(state) {
  if (state === PS.BLOCKED) {
    const el = iconEl('ban', 'icon-danger');
    el.title = 'Blocked';
    return el;
  }
  const [key, cls] = MARKS[state] ?? MARKS[PS.STRANGER];
  return iconEl(key, cls);
}

/**
 * Red exclamation shown after the name of accounts WITHOUT admin identity
 * verification. Verified accounts render clean; the grey certificate is
 * RESERVED for future premium status — do not reuse it here.
 */
export function unverifiedBadgeEl() {
  return iconEl('identityAlert', 'verify-badge');
}

/**
 * Gold certificate for PREMIUM accounts — rendered wherever a name is
 * displayed (conversation rows, side-head, chat head, profile sheets).
 * Purely decorative: the certificate never replaces the red unverified
 * mark, it layers ON TOP of whatever trust state the name already wears.
 */
export function premiumBadgeEl(extraClass = '') {
  return iconEl('premium', `premium-badge${extraClass ? ` ${extraClass}` : ''}`);
}

/**
 * Inline-flex tag: icon + username (italic for gone). Returns the wrapper
 * so callers can drop it straight into a row/title.
 */
export function peerTagEl(state, name) {
  const span = document.createElement('span');
  span.className = `peer-tag${state === PS.GONE ? ' gone' : ''}`;
  span.append(peerStateIcon(state));
  const label = document.createElement('span');
  label.textContent = name;
  span.append(label);
  return span;
}
