// THE single source of badge artwork — the client app AND the admin panel
// render from this exact code (the admin's hand-copied mirror strings drifted
// twice; no more copies). Pure DOM (createElementNS), zero dependencies, so
// the same file works inside the app bundle and as a plain module on the
// admin page (it also self-registers a window global for the panel).
const NS = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}, kids = []) {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  n.append(...kids);
  return n;
}

/** Draw badge `id` into an existing <svg> (viewBox 0 0 100 100). */
export function drawBadgeArt(id, svg) {
  const art = ART[id];
  if (!art) return false;
  art(svg);
  return true;
}

/** Fresh standalone <svg> for a badge at the given pixel edge. */
export function badgeArtSvg(id, px = 96) {
  const svg = el('svg', { viewBox: '0 0 100 100', width: px, height: px, 'aria-hidden': 'true' });
  svg.classList.add('badge-ic', `badge-ic-${id}`);
  if (!drawBadgeArt(id, svg)) {
    const t = el('text', { x: 50, y: 58, 'text-anchor': 'middle', 'font-size': 40, fill: '#888' });
    t.textContent = '?';
    svg.append(t);
  }
  return svg;
}

function plate(svg, fill) {
  svg.append(el('rect', { x: 4, y: 4, width: 92, height: 92, rx: 24, fill }));
}

const ART = {
  og(svg) {
    // the CoCoNo mark, distilled: two linked rings (the double-C) on the
    // brand-purple plate, with OG across the base
    const grad = el('linearGradient', { id: 'ogGrad', x1: 0, y1: 0, x2: 1, y2: 1 },
      [['0', '#8f7ff0'], ['1', '#4b3fa8']].map(([off, col]) => el('stop', { offset: off, 'stop-color': col })));
    svg.append(el('defs', {}, [grad]));
    plate(svg, 'url(#ogGrad)');
    svg.append(el('g', { fill: 'none', stroke: '#ffffff', 'stroke-width': 7, 'stroke-linecap': 'round' },
      // open rings (C shapes) facing each other and interlocking
      [39, 61].map((cx) => el('path', { d: `M ${cx + 12} 36 A 15 15 0 1 0 ${cx + 12} 62` }))));
    const txt = el('text', { x: 50, y: 88, 'text-anchor': 'middle', fill: '#ffe9a8', 'font-size': 20, 'font-weight': 800, 'font-family': 'system-ui, sans-serif' });
    txt.textContent = 'OG';
    svg.append(txt);
  },

  earlybird(svg) {
    plate(svg, '#243a4d');
    // a clean origami swallow in flight
    svg.append(el('path', { d: 'M18 62 L52 48 L84 24 L60 52 L88 60 L44 70 Z', fill: '#7fd4ff' }));
    svg.append(el('circle', { cx: 74, cy: 70, r: 7, fill: '#ffd76a' }));
  },

  premium(svg) {
    // the gold certificate: scalloped seal (one ring of bumps + inner
    // face) with red ribbon tails — the same mark the client's name chip
    // carries as a font glyph, drawn so ANY consumer renders it identically
    plate(svg, '#241f0e');
    const bumps = [];
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      bumps.push(el('circle', {
        cx: (50 + 26 * Math.cos(a)).toFixed(1),
        cy: (44 + 26 * Math.sin(a)).toFixed(1),
        r: 7, fill: '#f0c04a',
      }));
    }
    svg.append(...bumps);
    svg.append(el('circle', { cx: 50, cy: 44, r: 26, fill: '#f0c04a' }));
    svg.append(el('circle', { cx: 50, cy: 44, r: 20, fill: 'none', stroke: '#8a6d1d', 'stroke-width': 3 }));
    // ribbon tails
    svg.append(el('path', { d: 'M40 62 L34 88 L44 80 L50 92 L56 80 L66 88 L60 62 Z', fill: '#d05252' }));
    // center star
    svg.append(el('path', { d: 'M50 30 L53 38 L61 38 L55 43 L57 51 L50 46 L43 51 L45 43 L39 38 L47 38 Z', fill: '#241f0e' }));
  },

  teacherspet(svg) {
    plate(svg, '#2c3324');
    svg.append(el('path', { d: 'M50 40 C64 30 82 40 80 58 C78 74 64 84 50 78 C36 84 22 74 20 58 C18 40 36 30 50 40 Z', fill: '#d05252' }));
    svg.append(el('path', { d: 'M52 36 C56 24 68 22 74 24 C70 34 60 38 52 36 Z', fill: '#4c8a4f' }));
    svg.append(el('path', { d: 'M50 8 L54 18 L64 18 L56 24 L59 34 L50 28 L41 34 L44 24 L36 18 L46 18 Z', fill: '#f0c04a' }));
  },

  mail(svg) {
    // amber envelope, classic flap + five pips: the mailbox stamp of a
    // working account
    plate(svg, '#3b2f14');
    svg.append(el('rect', { x: 20, y: 36, width: 60, height: 38, rx: 7, fill: '#f0b954' }));
    svg.append(el('path', { d: 'M20 43 L50 62 L80 43', fill: 'none', stroke: '#3b2f14', 'stroke-width': 5, 'stroke-linecap': 'round' }));
    svg.append(el('g', { fill: '#3b2f14' },
      [0, 1, 2, 3, 4].map((i) => el('circle', { cx: 30 + i * 10, cy: 80, r: 2.4 }))));
  },
};

// Self-registration for the ADMIN panel: plain module script there (the
// classic app.js reads the global); the client imports the functions.
if (typeof window !== 'undefined') {
  window.badgeArtSvg = badgeArtSvg;
  window.drawBadgeArt = drawBadgeArt;
}
