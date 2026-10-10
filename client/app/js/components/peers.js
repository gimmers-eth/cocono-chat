// Peer-suggestions widget shared by 'New chat' (sidebar) and the forward
// dialog: lists users known on THIS device (message-store peers via
// store.knownPeers — no server contact) and filters as the input is typed.
// Tapping a row hands the username to onPick. The list hides itself when
// there is nothing to suggest (no local peers yet, or the typed text already
// matches a username exactly).
//
// Options: { max } caps the visible rows; { floating } turns the list into a
// dropdown that floats OVER the content below its (position:relative)
// container and dismisses on outside click.

import { knownPeers, loadFriends, loadPeerChips, loadPeerBlocked, loadPeerVerifications, loadPeerAvatars, loadPeerTags, loadPeerModeration } from '../store.js';
import { resolvePeerState, PS, moderationOf } from './peername.js';
import { lineKids } from './userline.js';
import { nameChipEl } from '../badges.js';
import { currentFilter } from '../tags.js';

export function createPeerSuggestions(listEl, { max = Infinity, floating = false, decorate = null } = {}) {
  let peers = [];
  let avatars = new Map();
  let tags = new Map(); // peer → [ids]; sorts the suggestion list (never hides)
  const taggedByActive = (p) => (tags.get(p) ?? []).includes(currentFilter());
  let getValue = () => '';
  let onPick = () => {};
  let dismissed = false;

  function paint() {
    if (!listEl) return;
    const q = getValue().trim().toLowerCase();
    // an EXACT match stays listed (it used to hide — the typing completion
    // read as "no such user" right when the name was fully typed)
    // Search is NEVER filtered by the sidebar tag — but the active tag
    // SORTS: tagged peers are checked first (stable for the rest).
    const items = peers.filter((p) => !q || p.includes(q));
    if (currentFilter() !== 'all') {
      items.sort((a, b) => (taggedByActive(b) ? 1 : 0) - (taggedByActive(a) ? 1 : 0));
    }
    items.length = Math.min(items.length, max);
    const frag = document.createDocumentFragment();
    for (const p of items) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      // profile photo when we have one (it rides the same avatar classes,
      // so sizing stays with .peer-list .avatar), else the initial
      let av;
      const rec = avatars.get(p);
      if (rec?.avatar) {
        av = document.createElement('img');
        av.className = 'avatar avatar-img';
        av.alt = '';
        av.src = `data:image/jpeg;base64,${rec.avatar}`;
      } else {
        av = document.createElement('span');
        av.className = 'avatar';
        av.textContent = p.slice(0, 1);
      }
      const name = document.createElement('span');
      name.textContent = `${p}`;
      btn.append(av, name);
      if (decorate) decorate(name, p); // async upgrade to the trust line (replaces text)
      btn.title = `${p}`;
      btn.addEventListener('click', () => {
        dismissed = true; // collapse after picking (re-shows on next focus)
        onPick(p);
        paint();
      });
      li.appendChild(btn);
      frag.appendChild(li);
    }
    listEl.replaceChildren(frag);
    listEl.hidden = items.length === 0 || dismissed;
  }

  async function refresh() {
    dismissed = false;
    try { peers = await knownPeers(); } catch { peers = []; }
    try { avatars = await loadPeerAvatars(); } catch { avatars = new Map(); }
    try { tags = await loadPeerTags(); } catch { tags = new Map(); }
    paint();
  }

  function dismiss() {
    dismissed = true;
    paint();
  }

  function wireInput(inputEl, pick) {
    getValue = () => inputEl.value;
    onPick = pick;
    inputEl.addEventListener('input', () => { dismissed = false; paint(); });
    inputEl.addEventListener('focus', refresh);
    if (floating) {
      // Outside click collapses the dropdown (the pick handler checks
      // contains() so clicks ON the list or input never dismiss).
      document.addEventListener('click', (e) => {
        if (listEl.hidden) return;
        if (listEl.contains(e.target) || inputEl.contains(e.target)) return;
        dismiss();
      });
    }
  }

  return { refresh, paint, wireInput, dismiss };
}

/**
 * Row decorator that swaps a plain name span for THE username component
 * (trust icon + worn badge + red-unverified mark) — used by the 'start a
 * chat' search and any other suggestion list. Reads the local mirrors
 * (friends/chips/blocked/verified) once per refresh; rows paint instantly
 * and re-decorate when the maps land (usually the same frame).
 */
export function makeTrustDecorator() {
  return async (nameEl, peer) => {
    const ul = String(peer).toLowerCase();
    const [fs, chips, blocked, verified, moderation] = await Promise.all([
      loadFriends().catch(() => []), loadPeerChips(), loadPeerBlocked(), loadPeerVerifications(), loadPeerModeration(),
    ]);
    const ent = fs.find((f) => f.peer === ul);
    const state = blocked.get(ul) ? PS.BLOCKED
      : resolvePeerState({
        gone: !!ent?.gone,
        bound: !!ent?.trusted,
        verified: !!ent?.verified,
        trusted: !!ent?.trust,
        // staff TIMEOUT / BAN outranks the ladder (peername.js)
        moderation: moderationOf(moderation.get(ul)),
      });
    const chip = nameChipEl(chips.get(ul) ?? null);
    if (chip) chip.classList.add('name-chip-inline');
    nameEl.replaceChildren(...lineKids({
      peer: ul,
      state,
      chipEl: chip,
      unverified: verified.get(ul) === false,
    }));
  };
}
