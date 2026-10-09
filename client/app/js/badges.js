// Badge definitions for the CLIENT — one class per badge, mirroring
// be/src/lib/badges.js (points/labels must stay in sync; the SERVER is
// authoritative for who holds what). Owns the artwork (two sizes), the
// blurb the detail modal shows, and the chip builder used wherever a name
// wears its badge.
//
// SVGs are built with createElementNS — the app bans innerHTML everywhere.

import { iconEl } from './icons.js';

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

  art(_svg) { /* subclass draws */ }

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

  art(svg) {
    // the CoCoNo mark, distilled: two linked rings (the double-C) on the
    // brand-purple plate, with OG across the base
    const plate = document.createElementNS(NS, 'rect');
    plate.setAttribute('x', '4'); plate.setAttribute('y', '4');
    plate.setAttribute('width', '92'); plate.setAttribute('height', '92');
    plate.setAttribute('rx', '24');
    plate.setAttribute('fill', 'url(#ogGrad)');
    const defs = document.createElementNS(NS, 'defs');
    const grad = document.createElementNS(NS, 'linearGradient');
    grad.setAttribute('id', 'ogGrad');
    grad.setAttribute('x1', '0'); grad.setAttribute('y1', '0');
    grad.setAttribute('x2', '1'); grad.setAttribute('y2', '1');
    for (const [off, col] of [['0', '#8f7ff0'], ['1', '#4b3fa8']]) {
      const stop = document.createElementNS(NS, 'stop');
      stop.setAttribute('offset', off);
      stop.setAttribute('stop-color', col);
      grad.append(stop);
    }
    defs.append(grad);
    const rings = document.createElementNS(NS, 'g');
    rings.setAttribute('fill', 'none');
    rings.setAttribute('stroke', '#ffffff');
    rings.setAttribute('stroke-width', '7');
    rings.setAttribute('stroke-linecap', 'round');
    for (const cx of [39, 61]) {
      const c = document.createElementNS(NS, 'path');
      // open rings (C shapes) facing each other and interlocking
      c.setAttribute('d', `M ${cx + 12} 36 A 15 15 0 1 0 ${cx + 12} 62`);
      rings.append(c);
    }
    const txt = document.createElementNS(NS, 'text');
    txt.setAttribute('x', '50'); txt.setAttribute('y', '88');
    txt.setAttribute('text-anchor', 'middle');
    txt.setAttribute('fill', '#ffe9a8');
    txt.setAttribute('font-size', '20');
    txt.setAttribute('font-weight', '800');
    txt.setAttribute('font-family', 'system-ui, sans-serif');
    txt.textContent = 'OG';
    svg.append(defs, plate, rings, txt);
  }
}

export class EarlyBirdBadge extends BadgeDef {
  id = 'earlybird';
  label = 'Early Bird';
  points = 3;
  cap = 1000;
  blurb = 'Joined CoCoNo before the end of 2026 — one of the first 1,000 accounts to get the word out.';

  art(svg) {
    const plate = document.createElementNS(NS, 'rect');
    plate.setAttribute('x', '4'); plate.setAttribute('y', '4');
    plate.setAttribute('width', '92'); plate.setAttribute('height', '92');
    plate.setAttribute('rx', '24');
    plate.setAttribute('fill', '#243a4d');
    const bird = document.createElementNS(NS, 'path');
    // a clean origami swallow in flight
    bird.setAttribute('d', 'M18 62 L52 48 L84 24 L60 52 L88 60 L44 70 Z');
    bird.setAttribute('fill', '#7fd4ff');
    const sun = document.createElementNS(NS, 'circle');
    sun.setAttribute('cx', '74'); sun.setAttribute('cy', '70');
    sun.setAttribute('r', '7');
    sun.setAttribute('fill', '#ffd76a');
    svg.append(plate, bird, sun);
  }
}

export class PremiumBadgeDef extends BadgeDef {
  id = 'premium';
  label = 'Premium';
  points = 5; // mirror of config.cocoPremiumBonus — the server score is the truth
  cap = null;
  blurb = 'A premium subscriber. The gold certificate funds the platform and lifts CoCo reputation.';

  icon(px) {
    // reuse the brand's certificate glyph rather than a bespoke SVG
    const wrap = document.createElement('span');
    wrap.className = 'badge-ic badge-ic-premium';
    const ic = iconEl('premium');
    ic.style.fontSize = `${Math.round(px * 0.9)}px`;
    wrap.append(ic);
    return wrap;
  }
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

class TeachersPetBadge extends BadgeDef {
  id = 'teacherspet';
  label = "Teacher's Pet";
  points = 1;
  cap = null;
  blurb = "Hand-picked by the platform staff — a small apple for the teacher's pet.";

  art(svg) {
    const plate = document.createElementNS(NS, 'rect');
    plate.setAttribute('x', '4'); plate.setAttribute('y', '4');
    plate.setAttribute('width', '92'); plate.setAttribute('height', '92');
    plate.setAttribute('rx', '24');
    plate.setAttribute('fill', '#2c3324');
    const apple = document.createElementNS(NS, 'path');
    apple.setAttribute('d', 'M50 40 C64 30 82 40 80 58 C78 74 64 84 50 78 C36 84 22 74 20 58 C18 40 36 30 50 40 Z');
    apple.setAttribute('fill', '#d05252');
    const leaf = document.createElementNS(NS, 'path');
    leaf.setAttribute('d', 'M52 36 C56 24 68 22 74 24 C70 34 60 38 52 36 Z');
    leaf.setAttribute('fill', '#4c8a4f');
    const star = document.createElementNS(NS, 'path');
    star.setAttribute('d', 'M50 8 L54 18 L64 18 L56 24 L59 34 L50 28 L41 34 L44 24 L36 18 L46 18 Z');
    star.setAttribute('fill', '#f0c04a');
    svg.append(plate, apple, leaf, star);
  }
}

export const BADGE_UI = new Map(
  [new OgBadge(), new EarlyBirdBadge(), new PremiumBadgeDef(), new TeachersPetBadge()].map((b) => [b.id, b]),
);
