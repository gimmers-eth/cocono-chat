// ---- BLOCK: one flow, two entry points (chat menu / stranger bar /
// Relationships list). The confirm modal COLLECTS THE REASON — exactly
// three choices, radio-style list (never a dropdown), OK stays disabled
// until one is picked. The reason id rides to the server (blockReasons),
// where it powers the blocker's recall in Settings and admin context.
// The blocked party never sees any of it.
import { confirmModal, toast } from './ui.js';
import { humanError } from './errors.js';
import { rememberPeerBlocked, friendDel } from './store.js';

export const BLOCK_REASONS = [
  ['nospeak', (p) => `I don’t want to speak to @${p}`],
  ['unknown', (p) => `I don’t know @${p}`],
  ['scam', (p) => `@${p} is trying to scam me`],
];

export const blockReasonLabel = (id, peer) =>
  (BLOCK_REASONS.find(([k]) => k === id)?.[1] ?? (() => `blocked @${peer}`))(peer);

/** Ask + block. Resolves true when the block landed. */
export async function blockUserWithConfirm(client, peer) {
  const ul = String(peer).toLowerCase();
  const chosen = { r: '' };
  const list = document.createElement('div');
  list.className = 'block-reasons';
  for (const [id, mk] of BLOCK_REASONS) {
    const label = document.createElement('label');
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'block-reason';
    radio.value = id;
    radio.addEventListener('change', () => { chosen.r = id; list.dispatchEvent(new Event('change')); });
    label.append(radio, document.createTextNode(` ${mk(ul)}`));
    list.append(label);
  }
  const ok = await confirmModal({
    title: `Block @${ul}?`,
    bodyEl: list,
    okLabel: 'Block',
    danger: true,
    // the reason is REQUIRED (the modal says so; the button enforces it)
    validate: () => !!chosen.r,
  });
  if (!ok) return false;
  try {
    await client.blockUser(ul, chosen.r);
    await rememberPeerBlocked(ul, true).catch(() => {});
    // the server severed the relation both ways — mirror it locally so the
    // sidebar/chat chrome repaints from truth before the next reconcile
    await friendDel(ul).catch(() => {});
    toast(`@${ul} blocked — they can’t reach you.`);
    return true;
  } catch (err) {
    toast(humanError(err), 'error');
    return false;
  }
}

/** Lift a block. Nothing is restored — relations are rebuilt deliberately. */
export async function unblockUser(client, peer) {
  const ul = String(peer).toLowerCase();
  try {
    await client.unblockUser(ul);
    await rememberPeerBlocked(ul, false).catch(() => {});
    toast(`@${ul} unblocked.`);
    return true;
  } catch (err) {
    toast(humanError(err), 'error');
    return false;
  }
}
