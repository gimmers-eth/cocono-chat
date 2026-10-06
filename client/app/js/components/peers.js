// Peer-suggestions widget shared by 'New chat' (sidebar) and the forward
// dialog: lists users known on THIS device (message-store peers via
// store.knownPeers — no server contact) and filters as the input is typed.
// Tapping a row hands the username to onPick. The list hides itself when
// there is nothing to suggest (no local peers yet, or the typed text already
// matches a username exactly).

import { knownPeers } from '../store.js';

export function createPeerSuggestions(listEl) {
  let peers = [];
  let getValue = () => '';
  let onPick = () => {};

  function paint() {
    if (!listEl) return;
    const q = getValue().trim().toLowerCase();
    const items = peers.filter((p) => (!q || p.includes(q)) && p !== q);
    const frag = document.createDocumentFragment();
    for (const p of items) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      const av = document.createElement('span');
      av.className = 'avatar';
      av.textContent = p.slice(0, 1);
      const name = document.createElement('span');
      name.textContent = `@${p}`;
      btn.append(av, name);
      btn.title = `@${p}`;
      btn.addEventListener('click', () => onPick(p));
      li.appendChild(btn);
      frag.appendChild(li);
    }
    listEl.replaceChildren(frag);
    listEl.hidden = items.length === 0;
  }

  async function refresh() {
    try { peers = await knownPeers(); } catch { peers = []; }
    paint();
  }

  function wireInput(inputEl, pick) {
    getValue = () => inputEl.value;
    onPick = pick;
    inputEl.addEventListener('input', paint);
    inputEl.addEventListener('focus', refresh);
  }

  return { refresh, paint, wireInput };
}
