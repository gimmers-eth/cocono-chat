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

import { knownPeers } from '../store.js';

export function createPeerSuggestions(listEl, { max = Infinity, floating = false } = {}) {
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
