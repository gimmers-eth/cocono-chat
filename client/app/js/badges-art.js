// THE single source of badge artwork — the client app AND the admin panel
// render from this exact code (the admin's hand-copied mirror strings drifted
// twice; no more copies). Pure DOM (createElementNS), zero dependencies, so
// the same file works inside the app bundle and as a plain module on the
// admin page (it also self-registers a window global for the panel).
//
// TWO DETAIL LEVELS, chosen by the pixel size the caller asks for:
//   small (< 32px) — name chips, badge chips, table rows: bold silhouette on
//     a simple gradient plate; every interior detail that would turn to mud
//     at 16px is dropped and the subject is scaled up to fill the plate.
//   full  (>= 32px) — the modals' hero: the same silhouette plus the jewellery
//     (metal rim, bevel light, inner shadow, sheen, sparks, secondary props).
// Same viewBox (0 0 100 100) for both, so any consumer scales freely.
//
// Every gradient/clip id is suffixed per rendered instance — a page shows
// many badges at once (and the same badge at two sizes), and colliding ids
// would let one instance's defs win for all of them.
const NS = 'http://www.w3.org/2000/svg';

let UID = 0;

function el(name, attrs = {}, kids = []) {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  n.append(...kids);
  return n;
}
const uid = (base) => `${base}${++UID}`;

/** Draw badge `id` into an existing <svg> (viewBox 0 0 100 100). Detail level
 *  follows the svg's own width attr, so every caller (app chips, app modal,
 *  admin rows, admin modal) gets the right artwork for its size for free. */
export function drawBadgeArt(id, svg) {
  const art = ART[id];
  if (!art) return false;
  const px = Number(svg.getAttribute('width') || 96);
  // full detail (wordmarks, seals, sparks) only pays off from ~64px up —
  // below that the small silhouette is the honest picture
  art(svg, px >= 64 ? 'full' : 'small');
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

// ---- shared painters ---------------------------------------------------

function lin(svg, u, stops, attrs = {}) {
  const id = uid(u);
  svg.append(el('defs', {}, [el('linearGradient', { id, x1: 0, y1: 0, x2: 0, y2: 1, ...attrs },
    stops.map(([off, col, op]) => el('stop', { offset: off, 'stop-color': col, ...(op != null ? { 'stop-opacity': op } : {}) })))]));
  return `url(#${id})`;
}

function rad(svg, u, stops, attrs = {}) {
  const id = uid(u);
  svg.append(el('defs', {}, [el('radialGradient', { id, cx: 0.5, cy: 0.42, r: 0.68, ...attrs },
    stops.map(([off, col, op]) => el('stop', { offset: off, 'stop-color': col, ...(op != null ? { 'stop-opacity': op } : {}) })))]));
  return `url(#${id})`;
}

/** The rounded plate every badge sits on. `pal` = [top, bottom, rimLight,
 *  rimDark]. full adds the metal rim, the top bevel light, the bottom inner
 *  shadow and a soft diagonal sheen; small keeps a plain two-stop gradient
 *  plus a whisper of top light (all of which would alias away at 16px). */
function plate(svg, pal, detail) {
  const clipId = uid('clip');
  svg.append(el('defs', {}, [el('clipPath', { id: clipId }, [el('rect', { x: 3, y: 3, width: 94, height: 94, rx: 25 })])]));
  const clip = `url(#${clipId})`;
  const base = lin(svg, 'plate', [[0, pal[0]], [0.55, pal[1]], [1, pal[2] ?? pal[1]]]);
  svg.append(el('rect', { x: 3, y: 3, width: 94, height: 94, rx: 25, fill: base }));
  if (detail === 'small') {
    svg.append(el('rect', { x: 3, y: 3, width: 94, height: 46, rx: 25, fill: lin(svg, 'ptop', [[0, '#ffffff', 0.16], [1, '#ffffff', 0]]) }));
    return clip;
  }
  // bevel: light from above, shade below, inside the plate edge
  svg.append(el('rect', { x: 3, y: 3, width: 94, height: 44, rx: 25, fill: lin(svg, 'ptop', [[0, '#ffffff', 0.22], [1, '#ffffff', 0]]) }));
  svg.append(el('rect', { x: 3, y: 52, width: 94, height: 45, rx: 25, fill: lin(svg, 'pbot', [[0, '#000000', 0], [1, '#000000', 0.34]]) }));
  // metal rim
  const rim = lin(svg, 'rim', [[0, pal[3]], [0.5, pal[4] ?? pal[3]], [1, pal[5] ?? pal[3]]]);
  svg.append(el('rect', { x: 4.2, y: 4.2, width: 91.6, height: 91.6, rx: 24, fill: 'none', stroke: rim, 'stroke-width': 2.4 }));
  // soft diagonal sheen band across the top-left half (static gloss),
  // feathered on both edges and clipped to the plate
  const sheen = lin(svg, 'sheen', [[0, '#ffffff', 0], [0.5, '#ffffff', 0.13], [1, '#ffffff', 0]], { x1: 0, y1: 0, x2: 1, y2: 0 });
  svg.append(el('g', { 'clip-path': clip }, [
    el('rect', { x: -30, y: -30, width: 62, height: 170, fill: sheen, transform: 'rotate(24 50 50)' }),
  ]));
  return clip;
}

/** A bright narrow band the modal CSS sweeps across the badge (`.badge-glint`).
 *  Invisible unless something animates it — the admin panel gets the static
 *  sheen only. Clipped to the plate by the caller's clip group. */
function glint(svg, clip) {
  const g = lin(svg, 'glint', [[0, '#ffffff', 0], [0.5, '#ffffff', 0.5], [1, '#ffffff', 0]], { x1: 0, y1: 0, x2: 1, y2: 0 });
  return el('g', { 'clip-path': clip }, [
    el('rect', { class: 'badge-glint', x: -30, y: -30, width: 24, height: 170, fill: g, transform: 'rotate(24 50 50)', opacity: 0 }),
  ]);
}

/** Four-point twinkle. The modal CSS pops these in sequence; elsewhere they
 *  sit as tiny static sparkles (full detail only). */
function spark(svg, cx, cy, r, fill, cls = 'badge-spark', op = 0.9) {
  return el('path', {
    class: cls, opacity: op, fill,
    d: `M${cx} ${cy - r} C${cx + r * 0.16} ${cy - r * 0.22} ${cx + r * 0.22} ${cy - r * 0.16} ${cx + r} ${cy} C${cx + r * 0.22} ${cy + r * 0.16} ${cx + r * 0.16} ${cy + r * 0.22} ${cx} ${cy + r} C${cx - r * 0.16} ${cy + r * 0.22} ${cx - r * 0.22} ${cy + r * 0.16} ${cx - r} ${cy} C${cx - r * 0.22} ${cy - r * 0.16} ${cx - r * 0.16} ${cy - r * 0.22} ${cx} ${cy - r} Z`,
  });
}

/** Five-point star as a path (no font, no platform drift). */
function starPath(cx, cy, R, r, rot = -Math.PI / 2) {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const a = rot + (i * Math.PI) / 5;
    const rr = i % 2 === 0 ? R : r;
    pts.push(`${(cx + rr * Math.cos(a)).toFixed(2)} ${(cy + rr * Math.sin(a)).toFixed(2)}`);
  }
  return `M${pts.join(' L')} Z`;
}

// ---- the five badges ----------------------------------------------------

const ART = {
  // OG — the founding ten: the interlocked double-C monogram on brand violet,
  // with the OG wordmark drawn as stroked geometry (never a font glyph).
  og(svg, detail) {
    const small = detail === 'small';
    const clip = plate(svg, ['#9d8cf7', '#6a55d6', '#4b3aa8', '#e4dcff', '#b7a6ff', '#372a86'], detail);
    const sw = small ? 9.5 : 8;
    const cy = small ? 50 : 43;
    const r = small ? 15 : 14;
    const dx = small ? 10.5 : 11.5;
    // the double-C monogram: two open rings, both facing right, the right one
    // lifted over the left on a plate-coloured halo so the pair reads as two
    // linked marks and never melts into one blob
    const cL = arc(50 - dx, cy, r, 56, 304);
    const cR = arc(50 + dx, cy, r, 56, 304);
    svg.append(el('path', { d: cL, fill: 'none', stroke: '#ffffff', 'stroke-width': sw, 'stroke-linecap': 'round' }));
    svg.append(el('path', { d: cR, fill: 'none', stroke: '#5b48c0', 'stroke-width': sw + 5, 'stroke-linecap': 'round' }));
    svg.append(el('path', { d: cR, fill: 'none', stroke: '#ffffff', 'stroke-width': sw, 'stroke-linecap': 'round' }));
    if (!small) {
      // OG wordmark: O = ring, G = ring open right + jaw — stroked, not typed
      const wy = 79, wr = 7.2, wsw = 4.4;
      svg.append(el('g', { fill: 'none', stroke: '#ffe9a8', 'stroke-width': wsw, 'stroke-linecap': 'round' }, [
        el('circle', { cx: 41, cy: wy, r: wr }),
        el('path', { d: arc(59.5, wy, wr, 44, 316) }),
        el('path', { d: `M${59.5 + wr - 0.6} ${wy} L${59.5 + 1.5} ${wy}` }),
      ]));
      svg.append(spark(svg, 80, 22, 6, '#ffffff', 'badge-spark', 0.85));
      svg.append(spark(svg, 20, 74, 4.4, '#e4dcff', 'badge-spark badge-spark-2', 0.7));
      svg.append(glint(svg, clip));
    }
  },

  // Early Bird — a swallow climbing out of the dawn: gold sun on the horizon
  // behind curved wings (the old straight-line bird read as a paper plane).
  earlybird(svg, detail) {
    const small = detail === 'small';
    const clip = plate(svg, ['#33566f', '#1d3a52', '#12283a', '#bfe6ff', '#7fc4e8', '#0d1e2c'], detail);
    if (!small) {
      // rising sun + horizon glow
      svg.append(el('circle', { cx: 50, cy: 82, r: 12, fill: rad(svg, 'sun', [[0, '#fff3c4'], [0.55, '#ffd76a'], [1, '#f2a93b']]) }));
      svg.append(el('ellipse', { cx: 50, cy: 85, rx: 34, ry: 8, fill: rad(svg, 'sunglow', [[0, '#ffd76a', 0.45], [1, '#ffd76a', 0]]) }));
    }
    // a swallow soaring at the viewer: swept-up wings, forked tail
    const bird = 'M50 22 C52 28 53 34 52 40 C61 31 73 25 87 25 C78 33 68 40 59 45 C58 53 55 60 52 66 L50 59 L48 66 C45 60 42 53 41 45 C32 40 22 33 13 25 C27 25 39 31 48 40 C47 34 48 28 50 22 Z';
    svg.append(el('path', {
      d: bird, fill: lin(svg, 'bird', [[0, '#e8fbff'], [0.45, '#9fe4ff'], [1, '#4fb7e8']]),
      ...(small ? { transform: 'translate(50 50) scale(1.1) translate(-50 -50)' } : {}),
    }));
    if (!small) {
      svg.append(spark(svg, 24, 22, 5, '#ffffff', 'badge-spark', 0.8));
      svg.append(spark(svg, 80, 62, 4, '#cdefff', 'badge-spark badge-spark-2', 0.7));
      svg.append(glint(svg, clip));
    }
  },

  // Premium — the gold certificate: scalloped rosette, embossed star, folded
  // ribbon tails. The rosette bumps are a dashed stroke ring (one element,
  // crisp at every size) instead of twelve loose circles.
  premium(svg, detail) {
    const small = detail === 'small';
    const clip = plate(svg, ['#4a3a12', '#332708', '#201804', '#ffe9a8', '#d9b45a', '#6b521a'], detail);
    const cy = small ? 50 : 44;
    const R = small ? 27 : 25;
    // ribbon tails first (behind the seal)
    if (!small) {
      svg.append(el('path', { d: 'M39 60 L31 90 L42 81 L50 94 L58 81 L69 90 L61 60 Z', fill: lin(svg, 'rib', [[0, '#e0606a'], [1, '#9c2b36']]) }));
      svg.append(el('path', { d: 'M50 62 L50 94 L58 81 L69 90 L61 60 Z', fill: '#000000', opacity: 0.18 }));
    } else {
      svg.append(el('path', { d: 'M40 62 L35 86 L45 78 L50 88 L55 78 L65 86 L60 62 Z', fill: '#c04550' }));
    }
    // rosette: scalloped edge = thick dashed stroke on a circle
    const circ = 2 * Math.PI * (R - 3.4);
    svg.append(el('circle', {
      cx: 50, cy, r: R - 3.4, fill: 'none', stroke: small ? '#e8b83f' : '#f0c04a',
      'stroke-width': 9, 'stroke-dasharray': `${(circ / 24).toFixed(2)} ${(circ / 24).toFixed(2)}`, 'stroke-linecap': 'round',
    }));
    svg.append(el('circle', { cx: 50, cy, r: R - 3, fill: rad(svg, 'face', [[0, '#ffe9a0'], [0.6, '#f0c04a'], [1, '#c98f1b']]) }));
    svg.append(el('circle', { cx: 50, cy, r: R - 8.5, fill: 'none', stroke: small ? '#a87613' : '#8a6d1d', 'stroke-width': 2.4, opacity: 0.85 }));
    // embossed star: dark well + light catch on the top-left edges
    svg.append(el('path', { d: starPath(50, cy + 0.6, R * 0.52, R * 0.21), fill: '#7a5a10' }));
    svg.append(el('path', { d: starPath(50, cy - 0.6, R * 0.52, R * 0.21), fill: small ? '#5c430c' : '#6b4e0e' }));
    if (!small) {
      svg.append(el('ellipse', { cx: 42, cy: cy - 12, rx: 13, ry: 7, fill: '#ffffff', opacity: 0.28, transform: `rotate(-24 42 ${cy - 12})` }));
      svg.append(spark(svg, 81, 20, 6, '#fff6d8', 'badge-spark', 0.9));
      svg.append(spark(svg, 19, 30, 4.2, '#ffe9a8', 'badge-spark badge-spark-2', 0.75));
      svg.append(glint(svg, clip));
    }
  },

  // Teacher's Pet — the staff apple with its gold star sticker.
  teacherspet(svg, detail) {
    const small = detail === 'small';
    const clip = plate(svg, ['#48552f', '#333d22', '#212816', '#d8e8b0', '#9db56a', '#171c0f'], detail);
    const s = small ? 1.14 : 1;
    const g = el('g', small ? {} : { transform: 'translate(0 3)' });
    if (small) g.setAttribute('transform', 'translate(50 54) scale(1.12) translate(-50 -54)');
    // leaf (left of the stem — the star sticker owns the right) + stem
    g.append(el('path', { d: 'M47 33 C44 23 34 19 25 21 C27 31 38 37 47 33 Z', fill: lin(svg, 'leaf', [[0, '#8fd06a'], [1, '#3f7d33']]) }));
    g.append(el('path', { d: 'M50 38 C50 31 51 27 55 23', fill: 'none', stroke: '#7a4a22', 'stroke-width': 4.4, 'stroke-linecap': 'round' }));
    // apple body: two lobes, dimple at the stem
    g.append(el('path', {
      d: 'M50 40 C43 31 26 32 21 46 C16 61 29 80 41 82 C45 83 48 81 50 81 C52 81 55 83 59 82 C71 80 84 61 79 46 C74 32 57 31 50 40 Z',
      fill: rad(svg, 'apple', [[0, '#ff8d7a'], [0.55, '#e04a4f'], [1, '#a92530']], { cx: 0.38, cy: 0.32, r: 0.85 }),
    }));
    g.append(el('ellipse', { cx: 36, cy: 48, rx: 8, ry: 12, fill: '#ffffff', opacity: 0.3, transform: 'rotate(-22 36 48)' }));
    svg.append(g);
    // the gold star sticker, top-right of the apple
    const sx = small ? 74 : 76, sy = small ? 28 : 26, sR = small ? 15 : 14;
    svg.append(el('path', { d: starPath(sx, sy + 1.4, sR, sR * 0.42), fill: '#000000', opacity: 0.3 }));
    svg.append(el('path', { d: starPath(sx, sy, sR, sR * 0.42), fill: lin(svg, 'star', [[0, '#fff3c4'], [0.5, '#ffd76a'], [1, '#e8a52f']]) }));
    if (!small) {
      svg.append(spark(svg, 24, 74, 5, '#ffffff', 'badge-spark', 0.8));
      svg.append(spark(svg, 46, 14, 4, '#ffd76a', 'badge-spark badge-spark-2', 0.7));
      svg.append(glint(svg, clip));
    }
  },

  // You've got mail — the stamped envelope: wax seal on the flap point.
  mail(svg, detail) {
    const small = detail === 'small';
    const clip = plate(svg, ['#6b4d1c', '#4a3413', '#2e2008', '#ffe1a0', '#d9a95a', '#59400f'], detail);
    const y = small ? 30 : 32, h = small ? 44 : 40;
    svg.append(el('rect', { x: 16, y, width: 68, height: h, rx: 8, fill: lin(svg, 'env', [[0, '#ffe0a1'], [0.5, '#f5c261'], [1, '#d99a2b']]) }));
    // inner pocket shade + the flap
    svg.append(el('path', { d: `M16 ${y + 8} L50 ${y + h - 8} L84 ${y + 8} L84 ${y + h - 8} Q84 ${y + h} 76 ${y + h} L24 ${y + h} Q16 ${y + h} 16 ${y + h - 8} Z`, fill: '#000000', opacity: 0.1 }));
    svg.append(el('path', { d: `M17 ${y + 3} L50 ${y + h * 0.62} L83 ${y + 3}`, fill: 'none', stroke: small ? '#8a5f14' : '#7a5210', 'stroke-width': small ? 6 : 5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    svg.append(el('path', { d: `M17 ${y + 1.5} L50 ${y + h * 0.62 - 1.5} L83 ${y + 1.5}`, fill: 'none', stroke: '#fff3d0', 'stroke-width': 2, opacity: 0.55, 'stroke-linecap': 'round' }));
    if (!small) {
      // wax seal at the flap point
      svg.append(el('circle', { cx: 50, cy: y + h * 0.62 + 1, r: 8.5, fill: rad(svg, 'wax', [[0, '#ff8d7a'], [0.6, '#d0454f'], [1, '#8e1f2a']]) }));
      svg.append(el('circle', { cx: 50, cy: y + h * 0.62 + 1, r: 5, fill: 'none', stroke: '#7c1822', 'stroke-width': 1.6 }));
      svg.append(el('ellipse', { cx: 47.4, cy: y + h * 0.62 - 1.6, rx: 2.6, ry: 1.7, fill: '#ffffff', opacity: 0.4, transform: `rotate(-24 47.4 ${y + h * 0.62 - 1.6})` }));
      svg.append(spark(svg, 82, 22, 5, '#fff3d0', 'badge-spark', 0.85));
      svg.append(spark(svg, 18, 80, 4, '#ffe1a0', 'badge-spark badge-spark-2', 0.7));
      svg.append(glint(svg, clip));
    }
  },
};

/** Open-ring arc: circle at (cx,cy) r, from angle a0 to a1 (degrees, screen
 *  coords), drawn the long way when the span exceeds 180. */
function arc(cx, cy, r, a0, a1) {
  const p = (a) => [cx + r * Math.cos((a * Math.PI) / 180), cy + r * Math.sin((a * Math.PI) / 180)];
  const [x0, y0] = p(a0);
  const [x1, y1] = p(a1);
  const span = ((a1 - a0) % 360 + 360) % 360;
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${span > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

// Self-registration for the ADMIN panel: plain module script there (the
// classic app.js reads the global); the client imports the functions.
if (typeof window !== 'undefined') {
  window.badgeArtSvg = badgeArtSvg;
  window.drawBadgeArt = drawBadgeArt;
}
