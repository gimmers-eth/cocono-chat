// ---- REPORT: one flow, one entry point (chat menu ⋮ → Report user).
// Mirrors the block flow (blocks.js): same modal, same radio-style reason
// list (never a dropdown), OK stays disabled until the form is complete.
// Reporting asks WHY (four fixed reasons) plus a REQUIRED free-text
// description, and hands the server this device's decrypted transcript of
// the chat — the E2EE copy the server holds is unreadable, so the warning
// says plainly that the history leaves this device unencrypted. The block
// checkbox defaults ON: people who report usually want the door shut too,
// and the server applies both in one atomic act.
import { confirmModal, toast } from './ui.js';
import { iconEl } from './icons.js';
import { humanError } from './errors.js';
import { rememberPeerBlocked, friendDel, messagesWith } from './store.js';

export const REPORT_REASONS = [
  ['scamming', 'Scamming', 'reasonScam'],
  ['harassment', 'Harassment or hate speech', 'reasonHarassment'],
  ['graphic', 'Unsolicited graphic material', 'reasonGraphic'],
  ['other', 'Other', 'reasonUnknown'],
];

export const reportReasonLabel = (id) =>
  REPORT_REASONS.find(([k]) => k === id)?.[1] ?? id;

// server caps the transcript at 500 lines; send a hair less so the newest
// context always lands even in a huge chat
const MAX_TRANSCRIPT = 400;

/** Ask + report. Resolves the server verdict ({ reported, blocked }) or
 *  false when the user backed out. */
export async function reportUserWithConfirm(client, peer) {
  const ul = String(peer).toLowerCase();
  const chosen = { r: '', description: '', block: true };
  const form = document.createElement('div');
  form.className = 'report-form';

  const list = document.createElement('div');
  list.className = 'block-reasons'; // shared choice-list look with the block modal
  for (const [id, label, icon] of REPORT_REASONS) {
    const labelEl = document.createElement('label');
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'report-reason';
    radio.value = id;
    radio.addEventListener('change', () => { chosen.r = id; form.dispatchEvent(new Event('change', { bubbles: true })); });
    labelEl.append(radio, iconEl(icon, 'reason-icon'), document.createTextNode(` ${label}`));
    list.append(labelEl);
  }

  const desc = document.createElement('textarea');
  desc.className = 'report-desc';
  desc.rows = 3;
  desc.placeholder = `What did @${ul} do? (required)`;
  desc.addEventListener('input', () => {
    chosen.description = desc.value;
    // 'change' (what confirmModal's validate listens for) only fires on blur;
    // re-sync the OK button while the user types (bubbles: true — the modal
    // watches its body container, a non-bubbling event dies at the textarea)
    form.dispatchEvent(new Event('change', { bubbles: true }));
  });

  const blockRow = document.createElement('label');
  blockRow.className = 'report-block';
  const blockChk = document.createElement('input');
  blockChk.type = 'checkbox';
  blockChk.checked = true; // default ON: report + block together
  blockChk.addEventListener('change', () => { chosen.block = blockChk.checked; });
  blockRow.append(blockChk, iconEl('ban', 'reason-icon'), document.createTextNode(` Also block @${ul}`));

  form.append(list, desc, blockRow);

  const ok = await confirmModal({
    title: `Report @${ul}?`,
    bodyEl: form,
    okLabel: 'Report',
    danger: true,
    warning: `Your chat history with @${ul} will be sent to the server UNENCRYPTED so it can be reviewed.`,
    // reason AND description are required (the modal says so; the button enforces it)
    validate: () => !!chosen.r && !!chosen.description.trim(),
  });
  if (!ok) return false;

  // newest-first slice of the decrypted transcript (real messages only —
  // local system notices are our own UI chrome, not conversation evidence)
  const transcript = (await messagesWith(ul).catch(() => []))
    .filter((m) => m.dir === 'in' || m.dir === 'out')
    .sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))
    .slice(-MAX_TRANSCRIPT);

  try {
    const res = await client.reportUser(ul, {
      reason: chosen.r,
      description: chosen.description.trim(),
      messages: transcript,
      block: chosen.block,
    });
    if (res.blocked) {
      // the server blocked + severed the relation — mirror it locally so the
      // sidebar/chat chrome repaints from truth before the next reconcile
      await rememberPeerBlocked(ul, true).catch(() => {});
      await friendDel(ul).catch(() => {});
    }
    toast(res.blocked
      ? `@${ul} reported and blocked — they can’t reach you.`
      : `@${ul} reported — thanks for the details.`);
    return { reported: true, blocked: !!res.blocked };
  } catch (err) {
    toast(humanError(err), 'error');
    return false;
  }
}
