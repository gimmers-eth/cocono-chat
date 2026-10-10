// ---- PEER TAGS: starred / family / personal / work ----
// One vocabulary, THREE surfaces that read it: the chat-head tag row
// (tap to toggle), the sidebar filter bar (single-select over tags + All),
// and the admin panel's Relationships table (grey vs purple icons — that
// app mirrors TAG_IDS/TAG_LABELS deliberately, keep them in step).
// Tags are the tagger's OWN labels: the server stores them on the account
// doc (never shown to the tagged party) and every device re-pulls the map
// (store.saveTagServerMap) so the mirror always matches the account.
import { iconEl } from './icons.js';
import { toast } from './ui.js';
import { humanError } from './errors.js';
import { rememberPeerTags, loadPeerTags } from './store.js';

// order = the order the filter bar and chat row draw their icons
export const TAG_IDS = ['starred', 'family', 'personal', 'work'];
export const TAG_LABELS = {
  starred: 'Starred',
  family: 'Family',
  personal: 'Personal',
  work: 'Work',
};
const TAG_ICON = { starred: 'tagStar', family: 'tagFamily', personal: 'tagPersonal', work: 'tagWork' };

export const tagIconEl = (id, extraClass = '') => iconEl(TAG_ICON[id] ?? 'tagStar', extraClass);

// The sidebar's active FILTER: one tag id, or 'all' (default; 'all' is
// never switched off — clearing the active tag returns to it). Module state
// so the conversation list, the search ordering, and the filter bar all
// agree without prop-drilling.
let activeFilter = 'all';
export const currentFilter = () => activeFilter;
export const setFilter = (id) => { activeFilter = TAG_IDS.includes(id) ? id : 'all'; };

// The filter bar DOM (index.html #convo-filter): radio behaviour + purple
// active state. onChange repaints the conversation list. Buttons keep
// their static data-icon glyphs; only aria-pressed/class move.
export function wireFilterBar(barEl, onChange) {
  if (!barEl) return;
  const sync = () => {
    for (const btn of barEl.querySelectorAll('.filter-btn')) {
      const on = btn.dataset.tag === activeFilter;
      btn.setAttribute('aria-pressed', String(on));
      btn.classList.toggle('filter-on', on);
    }
  };
  barEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.filter-btn');
    if (!btn) return;
    const tag = btn.dataset.tag;
    // clicking the ACTIVE tag falls back to 'all'; 'all' itself can never
    // be turned off (the spec: it clears only when another icon is picked)
    setFilter(tag === activeFilter ? 'all' : tag);
    sync();
    onChange?.();
  });
  sync();
}

/** Toggle one tag on one peer. Resolves the new set (server-normalised). */
export async function togglePeerTag(client, peer, id) {
  const ul = String(peer).toLowerCase();
  if (!TAG_IDS.includes(id)) return null;
  const cur = (await loadPeerTags()).get(ul) ?? [];
  const on = !cur.includes(id);
  const next = on ? [...cur, id].sort() : cur.filter((t) => t !== id);
  try {
    const res = await client.setPeerTags(ul, next);
    // mirror the SERVER's normalised set — the mirror and the account can
    // never drift, whatever the enum drops on the way up
    await rememberPeerTags(ul, res.tags ?? next);
    toast(on ? `@${ul} tagged ${TAG_LABELS[id]}.` : `${TAG_LABELS[id]} tag removed from @${ul}.`);
    return res.tags ?? next;
  } catch (err) {
    toast(humanError(err), 'error');
    return null;
  }
}
