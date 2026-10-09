// Badge definitions for the CLIENT — one class per badge, mirroring
// be/src/lib/badges.js (points/labels must stay in sync; the SERVER is
// authoritative for who holds what). Owns the artwork (two sizes), the
// blurb the detail modal shows, and the chip builder used wherever a name
// wears its badge.
//
// All ARTWORK lives in one shared module (badges-art.js) that the ADMIN
// PANEL also loads — same code, same pixels, no mirrors to drift. Built
// with createElementNS — the app bans innerHTML everywhere.

import { drawBadgeArt } from './badges-art.js';

const NS = 'http://www.w3.org/2000/svg';

export class BadgeDef {
  id = null;
  label = null;
  points = 0;
  cap = null;
  blurb = null;
  animated = false;

  /** @param {number} px square edge */
  icon(px) {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('width', String(px));
    svg.setAttribute('height', String(px));
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('badge-ic', `badge-ic-${this.id}`);
    this.art(svg);
    return svg;
  }

  art(svg) { drawBadgeArt(this.id, svg); }

  /** chip = small icon + label — the profile BADGES row. Always an enabled
   *  button: clicking it opens the badge detail modal (a disabled button
   *  would swallow those clicks). */
  chip() {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = `badge-chip badge-chip-${this.id}`;
    el.dataset.badge = this.id;
    el.title = `${this.label} badge — details`;
    el.append(this.icon(18));
    const lab = document.createElement('span');
    lab.textContent = this.label;
    el.append(lab);
    return el;
  }
}

export class OgBadge extends BadgeDef {
  id = 'og';
  label = 'OG';
  points = 10;
  cap = 10;
  animated = true;
  blurb = 'One of the first ten accounts on CoCoNo.';

}

export class EarlyBirdBadge extends BadgeDef {
  id = 'earlybird';
  label = 'Early Bird';
  points = 3;
  cap = 1000;
  blurb = 'Joined CoCoNo before the end of 2026 — one of the first 1,000 accounts to get the word out.';

}

export class PremiumBadgeDef extends BadgeDef {
  id = 'premium';
  label = 'Premium';
  points = 5; // mirror of config.cocoPremiumBonus — the server score is the truth
  cap = null;
  blurb = 'A premium subscriber. The gold certificate funds the platform and lifts CoCo reputation.';

  // NO bespoke icon() anymore: the certificate SVG (badges-art.js) is the
  // one image every surface — app chips, modals and the admin panel — shares
}

/** The small mark a NAME wears (chat head, sidebar row, side-head). */
export function nameChipEl(badgeId) {
  const def = BADGE_UI.get(badgeId);
  if (!def) return null;
  const wrap = document.createElement('span');
  wrap.className = `badge-name-chip badge-name-${badgeId}`;
  wrap.dataset.badge = badgeId;
  wrap.title = `${def.label} badge`;
  wrap.append(def.icon(16));
  return wrap;
}

/**
 * "You've got mail" — first five messages sent. Amber envelope with the
 * classic flap + five pips: the mailbox stamp of a working account.
 */
class MailBadge extends BadgeDef {
  id = 'mail';
  label = "You've got mail";
  points = 2;
  cap = null;
  blurb = 'Your first five messages went out into the world. The mailbox only fills up from here.';

}

class TeachersPetBadge extends BadgeDef {
  id = 'teacherspet';
  label = "Teacher's Pet";
  points = 1;
  cap = null;
  blurb = "Hand-picked by the platform staff — a small apple for the teacher's pet.";

}

export const BADGE_UI = new Map(
  [new OgBadge(), new EarlyBirdBadge(), new PremiumBadgeDef(), new TeachersPetBadge(), new MailBadge()].map((b) => [b.id, b]),
);
