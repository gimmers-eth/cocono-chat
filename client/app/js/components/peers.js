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

import { knownPeers, loadFriends, loadPeerChips, loadPeerBlocked, loadPeerVerifications } from '../store.js';
import { resolvePeerState, PS } from './peername.js';
import { lineKids } from './userline.js';
import { nameChipEl } from '../badges.js';

export function createPeerSuggestions(listEl, { max = Infinity, floating = false, decorate = null } = {}) {
  let peers = [];
  let getValue = () => '';
  let onPick = () => {};
  let dismissed = false;

  function paint() {
    if (!listEl) return;
    const q = getValue().trim().toLowerCase();
    const items = peers.filter((p) => (!q || p.includes(q)) && p !== q).slice(0, max);
    const frag = document.createDocumentFragment();
    for (const p of items) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      const av = document.createElement('span');
      av.className = 'avatar';
      av.textContent = p.slice(0, 1);
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
    const [fs, chips, blocked, verified] = await Promise.all([
      loadFriends().catch(() => []), loadPeerChips(), loadPeerBlocked(), loadPeerVerifications(),
    ]);
    const ent = fs.find((f) => f.peer === ul);
    const state = blocked.get(ul) ? PS.BLOCKED
      : resolvePeerState({
        gone: !!ent?.gone,
        bound: !!ent?.trusted,
        verified: !!ent?.verified,
        trusted: !!ent?.trust,
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
