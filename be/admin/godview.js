// ============================================================================
// God View — the whole social graph, on one canvas.
//
// Data: the server-side snapshot (GET/POST /api/admin/graph, see
// be/src/routes/admin-routes/graph.js). It is generated ON DEMAND and stored,
// so this page never triggers a rebuild by being opened.
//
// Rendering split (deliberate):
//   • edges  -> one <canvas>, redrawn per frame. Thousands of directed,
//               dashed, glowing curves stay cheap, and line weight/dash/arrow
//               sizes are divided by the zoom so they never fatten up.
//   • nodes  -> HTML cards inside a CSS-transformed layer. That is what makes
//               the rich card possible: real profile photo, badge artwork from
//               the SHARED art module, crisp text at any zoom, and buttons
//               that link straight into the user panel.
//   • physics -> vendored d3-force (admin/vendor/d3/README.md). We drive it,
//               pin dragged nodes with fx/fy, and save the settled positions
//               back to the snapshot so the next open is the same picture.
//
// Everything interactive is pointer-event based (mouse, pen and touch share
// one code path) and the camera survives a page reload in localStorage.
// ============================================================================

const EDGE_STYLE = {
  // created: SOLID brand purple — the growth edges, the loudest thing here
  created: { color: '#8f7cf0', glow: 'rgba(125, 108, 224, 0.55)', width: 2.4, dash: null },
  // seen: DOTTED dark purple — a link opened by someone who already had an account
  seen: { color: '#6c5fd0', glow: null, width: 1.9, dash: [0.1, 6] },
  // messaged: DASHED teal — a different fact, a different rhythm and hue
  msg: { color: '#2fb3a5', glow: null, width: 1.6, dash: [7, 5] },
};
const LINK_DISTANCE = { created: 165, seen: 200, msg: 235 };

// card box in WORLD pixels (the card layer is scaled by the camera, so these
// are constant) — the edge trimmer cuts lines exactly at the card border
const CARD_W = 150;
const CARD_H = 94;
const TRIM_PAD = 7;

const MIN_K = 0.08;
const MAX_K = 3;
const CAM_KEY = 'cocono.admin.godview.camera';
// Nodes are real DOM cards, not canvas sprites: past this the browser stops
// being smooth and a stray "all" on a big box would look like a hang. The cap
// in the toolbar goes up to 1000/all, so this is the safety net behind it.
const HARD_NODE_CAP = 1500;

const ICONS = {
  shieldCheck: '<path d="M12 2.6 19 5.4v5.9c0 4.3-2.9 8.1-7 9.5-4.1-1.4-7-5.2-7-9.5V5.4l7-2.8Z"/><path d="m9.1 12.1 2 2 3.9-4"/>',
  alert: '<circle cx="12" cy="12" r="9.2"/><path d="M12 7.6v5.2M12 16.3h.01"/>',
  ban: '<circle cx="12" cy="12" r="9.2"/><path d="M5.5 5.5 18.5 18.5"/>',
  star: '<path d="m12 3.6 2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8L3.6 9.7l5.8-.8L12 3.6Z"/>',
  ghost: '<path d="M5 20V11a7 7 0 0 1 14 0v9l-2.3-1.8L14.4 20l-2.4-1.8L9.6 20l-2.3-1.8L5 20Z"/><path d="M9.5 10.5h.01M14.5 10.5h.01"/>',
  idCard: '<rect x="2.8" y="5" width="18.4" height="14" rx="2.4"/><circle cx="8.6" cy="11" r="2.1"/><path d="M5.4 16.2c.6-1.5 1.9-2.3 3.2-2.3s2.6.8 3.2 2.3M14.6 9.6h4M14.6 13h4"/>',
  share: '<circle cx="18" cy="5.6" r="2.6"/><circle cx="6" cy="12" r="2.6"/><circle cx="18" cy="18.4" r="2.6"/><path d="m8.3 10.8 7.4-3.9M8.3 13.2l7.4 3.9"/>',
  people: '<circle cx="9" cy="8.4" r="3.2"/><path d="M3.4 19.2c.6-3 2.9-4.7 5.6-4.7s5 1.7 5.6 4.7"/><path d="M16 5.6a3.2 3.2 0 0 1 0 6M17.4 14.9c2 .5 3.3 2.1 3.7 4.3"/>',
  crosshair: '<circle cx="12" cy="12" r="7.6"/><path d="M12 1.8v3.6M12 18.6v3.6M1.8 12h3.6M18.6 12h3.6"/><circle cx="12" cy="12" r="1.6"/>',
  pin: '<path d="M9 3.5h6l-.8 5.1 3 2.6-1.4 1.3H8.2L6.8 11.2l3-2.6L9 3.5Z"/><path d="M12 12.5V21"/>',
  unpin: '<path d="M9 3.5h6l-.8 5.1 3 2.6-1.4 1.3H8.2L6.8 11.2l3-2.6L9 3.5Z"/><path d="M12 12.5V21"/><path d="m4 4 16 16"/>',
  hide: '<path d="M3 3l18 18"/><path d="M10.6 6.4A9.9 9.9 0 0 1 12 6.3c5 0 9 4 9 5.7 0 .9-1.2 2.4-3 3.8M6.4 8.4C4.2 10 3 11.4 3 12c0 1.7 4 5.7 9 5.7 1.4 0 2.7-.3 3.8-.8"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  close: '<path d="M5.5 5.5l13 13M18.5 5.5l-13 13"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6.2 6.2l2.6 2.6M15.2 15.2l2.6 2.6M17.8 6.2l-2.6 2.6M8.8 15.2l-2.6 2.6"/>',
};

const svg = (name, cls = '') =>
  `<svg class="gv-i${cls ? ` ${cls}` : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" `
  + `stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

/**
 * @param {object} deps wired by admin/app.js (which owns the token, the user
 *   panel and the shared helpers): api, esc, fmtDate, fmtAgo, avatarUrl,
 *   openUser, setStatus, unameHtml
 */
export function initGodView(deps) {
  const { api, esc, fmtDate, fmtAgo, avatarUrl, openUser, setStatus } = deps;
  const $ = (id) => document.getElementById(id);

  const stage = $('gv-stage');
  const world = $('gv-world');
  const canvas = $('gv-canvas');
  const ctx = canvas.getContext('2d');
  const inspector = $('gv-inspector');

  let snapshot = null;          // the stored server snapshot
  let seedLayout = null;        // positions to start from (stored + on-screen)
  let allNodes = [];            // every node in the snapshot
  let allEdges = [];            // every edge in the snapshot
  let nodes = [];               // the visible subset (filters applied)
  let edges = [];
  let byUl = new Map();
  let cards = new Map();        // ul -> .gv-node element
  let sim = null;
  let hidden = new Set();       // uls hidden by hand from the inspector
  let cam = { k: 0.7, x: 0, y: 0 };
  let view = { w: 0, h: 0 };
  let focus = null;             // ul whose neighbourhood is lit
  let selected = null;          // ul in the inspector
  let query = '';
  let frozen = false;
  let rafQueued = false;
  let saveTimer = null;
  let layoutDirty = false;
  let capNote = null;           // set when HARD_NODE_CAP trimmed the picture

  const kindsOn = { created: true, seen: true, msg: true };

  // ---- camera -------------------------------------------------------------
  function loadCamera() {
    try {
      const raw = JSON.parse(localStorage.getItem(CAM_KEY) ?? 'null');
      if (raw && Number.isFinite(raw.k)) cam = { k: raw.k, x: raw.x ?? 0, y: raw.y ?? 0 };
    } catch { /* first run */ }
  }
  function saveCamera() {
    try { localStorage.setItem(CAM_KEY, JSON.stringify(cam)); } catch { /* private mode */ }
  }
  function applyCamera() {
    world.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.k})`;
    // world-locked dot grid (the gradient itself lives in style.css): same
    // numbers as the card layer's transform, so the grid pans and zooms with
    // the graph while the canvas stays free for the edges alone
    canvas.style.backgroundSize = `${44 * cam.k}px ${44 * cam.k}px`;
    canvas.style.backgroundPosition = `${cam.x}px ${cam.y}px`;
    stage.classList.toggle('gv-far', cam.k < 0.42);
    stage.classList.toggle('gv-near', cam.k > 1.4);
    scheduleDraw();
  }
  const toWorld = (sx, sy) => ({ x: (sx - cam.x) / cam.k, y: (sy - cam.y) / cam.k });

  function zoomAt(px, py, factor) {
    const k = Math.min(MAX_K, Math.max(MIN_K, cam.k * factor));
    const w = toWorld(px, py);
    cam = { k, x: px - w.x * k, y: py - w.y * k };
    applyCamera();
    saveCamera();
  }
  function fit(animate = true) {
    const pts = nodes.filter((n) => Number.isFinite(n.x) && Number.isFinite(n.y));
    if (!pts.length) return;
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    for (const n of pts) {
      minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
      minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
    }
    const bw = Math.max(200, maxX - minX + CARD_W * 2);
    const bh = Math.max(200, maxY - minY + CARD_H * 2);
    const k = Math.min(MAX_K, Math.max(MIN_K, Math.min(view.w / bw, view.h / bh) * 0.94));
    const target = { k, x: view.w / 2 - ((minX + maxX) / 2) * k, y: view.h / 2 - ((minY + maxY) / 2) * k };
    if (!animate) { cam = target; applyCamera(); saveCamera(); return; }
    glideTo(target);
  }
  function centreOn(ul, k = Math.max(cam.k, 1)) {
    const n = byUl.get(ul);
    if (!n) return;
    glideTo({ k, x: view.w / 2 - (n.x ?? 0) * k, y: view.h / 2 - (n.y ?? 0) * k });
  }
  // A short eased camera move: the difference between a tool and a toy —
  // unless the operator asked for no motion, in which case it just lands.
  const reduceMotion = () =>
    window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
  function glideTo(target, ms = 420) {
    if (reduceMotion()) { cam = target; applyCamera(); saveCamera(); return; }
    const from = { ...cam };
    const t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / ms);
      const e = 1 - (1 - p) ** 3; // easeOutCubic
      cam = {
        k: from.k + (target.k - from.k) * e,
        x: from.x + (target.x - from.x) * e,
        y: from.y + (target.y - from.y) * e,
      };
      applyCamera();
      if (p < 1) requestAnimationFrame(step);
      else saveCamera();
    };
    requestAnimationFrame(step);
  }

  // ---- canvas edge layer --------------------------------------------------
  function resizeCanvas() {
    const rect = stage.getBoundingClientRect();
    view = { w: rect.width, h: rect.height };
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    scheduleDraw();
  }

  function scheduleDraw() {
    if (rafQueued) return;
    rafQueued = true;
    requestAnimationFrame(() => { rafQueued = false; draw(); });
  }

  /** Cut a line back to the border of a card so the arrowhead sits ON it. */
  function trimTo(px, py, dx, dy) {
    const hw = CARD_W / 2 + TRIM_PAD;
    const hh = CARD_H / 2 + TRIM_PAD;
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    if (ax < 1e-6 && ay < 1e-6) return { x: px, y: py };
    const t = Math.min(ax > 1e-6 ? hw / ax : Infinity, ay > 1e-6 ? hh / ay : Infinity);
    return { x: px + dx * t, y: py + dy * t };
  }

  function draw() {
    if (!view.w) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, view.w, view.h);
    if (!edges.length) return;
    // world space: every length divided by k stays a constant SCREEN size
    ctx.setTransform(dpr * cam.k, 0, 0, dpr * cam.k, dpr * cam.x, dpr * cam.y);
    const k = cam.k;
    const lit = focus ? neighboursOf(focus) : null;

    for (const e of edges) {
      if (!kindsOn[e.k]) continue;
      const s = byUl.get(e.s);
      const t = byUl.get(e.t);
      if (!s || !t || !Number.isFinite(s.x) || !Number.isFinite(t.x)) continue;
      const active = !lit || lit.has(e.s) || lit.has(e.t);
      const style = EDGE_STYLE[e.k];
      const dim = query && !hits(e.s) && !hits(e.t);

      const dx = t.x - s.x;
      const dy = t.y - s.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 2) continue;
      const nx = -dy / dist;
      const ny = dx / dist;
      const bow = (e.bow ?? 0) * dist;
      const cx = (s.x + t.x) / 2 + nx * bow;
      const cy = (s.y + t.y) / 2 + ny * bow;
      // exact end tangents of the quadratic: card borders meet the curve, not
      // the straight line between centres
      let d1x = cx - s.x; let d1y = cy - s.y;
      let m1 = Math.hypot(d1x, d1y) || 1;
      d1x /= m1; d1y /= m1;
      let d2x = t.x - cx; let d2y = t.y - cy;
      let m2 = Math.hypot(d2x, d2y) || 1;
      d2x /= m2; d2y /= m2;
      const p1 = trimTo(s.x, s.y, d1x, d1y);
      const p2 = trimTo(t.x, t.y, -d2x, -d2y);

      const alpha = dim ? 0.06 : active ? 1 : 0.1;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = style.color;
      ctx.lineWidth = style.width / k;
      ctx.lineCap = style.dash && style.dash[0] < 1 ? 'round' : 'butt';
      if (style.dash) ctx.setLineDash(style.dash.map((d) => d / k));
      else ctx.setLineDash([]);
      if (style.glow && active && !dim) {
        ctx.shadowColor = style.glow;
        ctx.shadowBlur = 10 / k;
      }
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.quadraticCurveTo(cx, cy, p2.x, p2.y);
      ctx.stroke();

      // arrowhead: direction of travel, drawn as a filled triangle whose size
      // is divided by k so it stays a constant SCREEN size at any zoom
      ctx.shadowBlur = 0;
      ctx.setLineDash([]);
      ctx.fillStyle = style.color;
      const L = (e.k === 'created' ? 12 : 10) / k;
      const W = L * 0.46;
      const bx = -d2y; // unit perpendicular to the travel direction
      const by = d2x;
      ctx.beginPath();
      ctx.moveTo(p2.x, p2.y);
      ctx.lineTo(p2.x - d2x * L + bx * W, p2.y - d2y * L + by * W);
      ctx.lineTo(p2.x - d2x * L - bx * W, p2.y - d2y * L - by * W);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  const hitCache = new Map(); // query -> Set(ul)
  function hitSet() {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    if (hitCache.has(q)) return hitCache.get(q);
    const set = new Set(nodes.filter((n) => n.ul.includes(q) || String(n.u ?? '').toLowerCase().includes(q)).map((n) => n.ul));
    hitCache.set(q, set);
    return set;
  }
  const hits = (ul) => { const s = hitSet(); return !s || s.has(ul); };

  let neighbourCache = new Map(); // ul -> Set of uls (incl. itself)
  function neighboursOf(ul) {
    if (neighbourCache.has(ul)) return neighbourCache.get(ul);
    const set = new Set([ul]);
    for (const e of allEdges) {
      if (!kindsOn[e.k]) continue;
      if (e.s === ul) set.add(e.t);
      else if (e.t === ul) set.add(e.s);
    }
    neighbourCache.set(ul, set);
    return set;
  }

  // ---- node cards ---------------------------------------------------------
  function trustMark(n) {
    if (n.gone) return `<span class="gv-trust gone" title="account deleted — named by a child it created">${svg('ghost')}</span>`;
    // staff moderation OUTRANKS the trust ladder, exactly like in the app:
    // a timed-out (malicious) or banned account shows the danger mark no
    // matter what its verification state says (lib/moderation.js)
    if (n.banned) return `<span class="gv-trust bad" title="BANNED by CoCoNo staff — account data kept, platform use refused">${svg('ban')}</span>`;
    if (n.malicious) return `<span class="gv-trust bad" title="TIMED OUT by CoCoNo staff — identified as malicious, treated as unverified">${svg('alert')}</span>`;
    return n.verified
      ? `<span class="gv-trust ok" title="App: verified — an ID document was checked by a human">${svg('shieldCheck')}</span>`
      : `<span class="gv-trust bad" title="App: unverified — no ID has been checked">${svg('alert')}</span>`;
  }

  function cardHtml(n) {
    const badge = n.badge ? `<span class="badge-art gv-badge" data-art="${esc(n.badge)}" data-px="15"></span>` : '';
    const prem = n.premium ? `<span class="gv-prem" title="premium — gold certificate">${svg('star')}</span>` : '';
    // the trust state colours the card's leading edge too: zoomed right out,
    // when the glyphs are unreadable, the map still reads as a trust heatmap
    const state = n.gone ? 'is-ghost' : n.verified ? 'is-verified' : 'is-unverified';
    const coco = n.gone ? '' : `
      <span class="gv-coco${n.trusted ? ' trusted' : ''}" title="${n.trusted ? 'Social: trusted by the network' : 'Social: not yet trusted'}">
        CoCo ${n.coco ?? 0}${n.trusted ? `<i class="gv-dot"></i>` : ''}
      </span>`;
    return `
      <div class="gv-card ${state}" data-ul="${esc(n.ul)}">
        <div class="gv-card-main">
          <span class="gv-av" data-av="${esc(n.ul)}">${esc(n.ul.slice(0, 1))}</span>
          <span class="gv-id">
            <span class="gv-name">${trustMark(n)}<span class="gv-uname">@${esc(n.ul)}</span>${prem}</span>
            <span class="gv-sub">${badge}${coco}</span>
          </span>
        </div>
        <div class="gv-links">
          <button class="gv-link" data-act="profile" data-ul="${esc(n.ul)}" title="Open the profile panel">${svg('idCard')}</button>
          <button class="gv-link" data-act="shares" data-ul="${esc(n.ul)}" title="Shares tab">${svg('share')}</button>
          <button class="gv-link" data-act="relations" data-ul="${esc(n.ul)}" title="Relationships tab">${svg('people')}</button>
          <span class="gv-gen" title="${n.gone ? 'deleted account' : `generation ${n.gen ?? 0} · ${n.tree ?? 0} downstream`}">${n.gone ? '—' : `g${n.gen ?? 0}`}</span>
        </div>
      </div>`;
  }

  function buildCards() {
    world.replaceChildren();
    cards = new Map();
    const frag = document.createDocumentFragment();
    for (const n of nodes) {
      const el = document.createElement('div');
      el.className = 'gv-node';
      el.dataset.ul = n.ul;
      el.innerHTML = cardHtml(n);
      frag.append(el);
      cards.set(n.ul, el);
    }
    world.append(frag);
    paintAvatars();
    applyEmphasis();
  }

  // Photos are token-gated, so each one is a fetch: the app.js avatar cache
  // (shared with the users table) keeps this to one request per account, and
  // small batches keep a 400-node map from loading one image at a time.
  async function paintAvatars() {
    const pending = nodes.filter((n) => {
      if (!n.hasAvatar || n.gone) return false;
      const slot = cards.get(n.ul)?.querySelector('.gv-av');
      return slot && !slot.dataset.loaded;
    });
    for (let i = 0; i < pending.length; i += 6) {
      await Promise.all(pending.slice(i, i + 6).map(async (n) => {
        const url = await avatarUrl(n.ul);
        if (!url) return;
        const slot = cards.get(n.ul)?.querySelector('.gv-av');
        if (!slot || slot.dataset.loaded) return; // rebuilt while in flight
        slot.style.backgroundImage = `url("${url}")`;
        slot.dataset.loaded = '1';
        slot.textContent = '';
      }));
    }
  }

  function placeCards() {
    for (const n of nodes) {
      const el = cards.get(n.ul);
      if (!el || !Number.isFinite(n.x)) continue;
      el.style.transform = `translate3d(${n.x}px, ${n.y}px, 0)`;
    }
  }

  /** Dim / ring state: one pass, only when focus or query changes. */
  function applyEmphasis() {
    const lit = focus ? neighboursOf(focus) : null;
    const set = hitSet();
    for (const n of nodes) {
      const el = cards.get(n.ul);
      if (!el) continue;
      const card = el.firstElementChild;
      const match = !set || set.has(n.ul);
      card.classList.toggle('gv-dim', (lit ? !lit.has(n.ul) : false) || !match);
      card.classList.toggle('gv-hit', !!set && set.has(n.ul));
      card.classList.toggle('gv-sel', selected === n.ul);
      card.classList.toggle('gv-focus', focus === n.ul);
      card.classList.toggle('gv-pinned', n.fx != null);
    }
    scheduleDraw();
  }

  // ---- graph assembly -----------------------------------------------------
  /**
   * The visible subset: hand-hidden nodes out, loners optionally out, then a
   * cap on the most interesting accounts (degree-weighted, newest first as
   * the tie-break) so a big box still renders a readable picture.
   */
  function selectNodes() {
    const max = Number($('gv-max').value) || 0;
    const loners = $('gv-hide-loners').checked;
    const degree = new Map();
    for (const e of allEdges) {
      if (!kindsOn[e.k]) continue;
      degree.set(e.s, (degree.get(e.s) ?? 0) + 1);
      degree.set(e.t, (degree.get(e.t) ?? 0) + 1);
    }
    let list = allNodes.filter((n) => !hidden.has(n.ul));
    if (loners) list = list.filter((n) => (degree.get(n.ul) ?? 0) > 0);
    const weight = (n) => (n.invited ?? 0) * 4 + (n.tree ?? 0) * 2 + (n.viewers ?? 0) * 2
      + (n.sentTo ?? 0) + (n.heardFrom ?? 0) + (degree.get(n.ul) ?? 0);
    if (max && list.length > max) {
      list = list
        .slice()
        .sort((a, b) => (weight(b) - weight(a))
          || (new Date(b.createdAt ?? 0) - new Date(a.createdAt ?? 0))
          || a.ul.localeCompare(b.ul))
        .slice(0, max);
    }
    // safety net behind the toolbar cap: never hand the DOM more cards than a
    // browser can move smoothly, and say so rather than silently dropping them
    capNote = null;
    if (list.length > HARD_NODE_CAP) {
      const wanted = list.length;
      list = list
        .slice()
        .sort((a, b) => (weight(b) - weight(a)) || a.ul.localeCompare(b.ul))
        .slice(0, HARD_NODE_CAP);
      capNote = `${wanted} nodes match — showing the ${HARD_NODE_CAP} most connected. `
        + 'Narrow it with the search box or the edge filters to see the rest.';
    }
    nodes = list;
    byUl = new Map(nodes.map((n) => [n.ul, n]));
    // only edges whose BOTH ends are on screen (a dangling line is a lie)
    const pairs = new Map(); // unordered pair -> [edges]
    edges = allEdges.filter((e) => {
      if (!kindsOn[e.k]) return false;
      if (!byUl.has(e.s) || !byUl.has(e.t)) return false;
      const key = e.s < e.t ? `${e.s}|${e.t}` : `${e.t}|${e.s}`;
      if (!pairs.has(key)) pairs.set(key, []);
      pairs.get(key).push(e);
      return true;
    });
    // bow siblings apart so A->B and B->A never overlap into one line
    for (const group of pairs.values()) {
      const n = group.length;
      group.forEach((e, i) => {
        const base = n === 1 ? 0.03 : 0.16;
        // a lone edge gets a whisper of curve; siblings fan out symmetrically.
        // The sign flips with the direction so a mutual pair parts ways.
        const dir = e.s < e.t ? 1 : -1;
        e.bow = (i - (n - 1) / 2) * base * 2 * dir || base * dir;
      });
    }
    neighbourCache = new Map();
    return degree;
  }

  function buildSim(seedLayout) {
    if (sim) { sim.stop(); sim = null; }
    const d3 = window.d3;
    if (!d3?.forceSimulation) {
      setStatus('God View needs the vendored d3-force files (admin/vendor/d3)', 'error');
      return;
    }
    // seed: the saved layout when it covers these nodes, else a phyllotaxis
    // spiral (deterministic, no overlap, no initial explosion)
    let seeded = 0;
    let i = 0;
    for (const n of nodes) {
      const saved = seedLayout?.[n.ul];
      if (saved) { n.x = saved[0]; n.y = saved[1]; seeded += 1; }
      else if (!Number.isFinite(n.x)) {
        const r = 46 * Math.sqrt(i + 0.5);
        const a = (i + 0.5) * 2.399963;
        n.x = r * Math.cos(a);
        n.y = r * Math.sin(a);
        i += 1;
      }
      // a dragged node stays pinned across rebuilds
      if (n.pinned) { n.fx = n.x; n.fy = n.y; }
      else { n.fx = null; n.fy = null; }
      n.vx = 0; n.vy = 0;
    }
    // d3's forceLink wants source/target and REPLACES them with node objects,
    // so it gets fresh link shells: our edges keep their s/t strings (the
    // canvas draws from those) and a rebuild never inherits stale references
    // to nodes a filter has since removed.
    const links = edges.map((e) => ({ source: e.s, target: e.t, k: e.k }));
    // a fully saved layout only needs to settle, not re-arrange: start cool so
    // reopening the page shows the SAME picture, plus a nudge into place
    const coverage = nodes.length ? seeded / nodes.length : 0;
    sim = d3.forceSimulation(nodes)
      .force('link', d3.forceLink(links)
        .id((d) => d.ul)
        .distance((l) => LINK_DISTANCE[l.k] ?? 200)
        .strength((l) => (l.k === 'created' ? 0.5 : l.k === 'seen' ? 0.22 : 0.08)))
      .force('charge', d3.forceManyBody()
        .strength((d) => -300 - 26 * Math.min(8, (d.invited ?? 0) + (d.sentTo ?? 0)))
        .distanceMax(1400))
      .force('collide', d3.forceCollide(() => 92).iterations(2))
      .force('x', d3.forceX(0).strength(0.035))
      .force('y', d3.forceY(0).strength(0.05))
      .alpha(coverage > 0.9 ? 0.22 : 1)
      .alphaDecay(0.032)
      .velocityDecay(0.36)
      .on('tick', () => { placeCards(); scheduleDraw(); markLayoutDirty(); })
      .on('end', () => { queueLayoutSave(); });
    if (frozen) sim.stop();
  }

  function markLayoutDirty() {
    if (!layoutDirty) {
      layoutDirty = true;
      const btn = $('gv-save-layout');
      if (btn) btn.disabled = false;
    }
  }
  function queueLayoutSave() {
    if (!snapshot || !layoutDirty) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveLayout, 1400); // settles -> one quiet autosave
  }
  async function saveLayout() {
    if (!snapshot) return;
    clearTimeout(saveTimer);
    // MERGE over the stored layout: filtered-out nodes are not on screen, but
    // their positions are still the server's to keep — replacing the whole doc
    // would silently throw away everything a filter happened to hide.
    const positions = { ...(snapshot.layout ?? {}) };
    for (const n of allNodes) {
      if (Number.isFinite(n.x) && Number.isFinite(n.y)) positions[n.ul] = [n.x, n.y];
    }
    try {
      await api('/api/admin/graph/layout', { method: 'PUT', body: JSON.stringify({ positions }) });
      snapshot.layout = positions;
      layoutDirty = false;
      $('gv-save-layout').disabled = true;
      stamp(`layout saved ${new Date().toLocaleTimeString()}`);
    } catch (err) {
      setStatus(`Saving the layout failed: ${err.message}`, 'error');
    }
  }

  // ---- snapshot -----------------------------------------------------------
  function stamp(text) { $('gv-stamp').textContent = text; }

  function adopt(snap, { fitAfter = true } = {}) {
    // Carry the positions currently ON SCREEN into the new snapshot: the server
    // layout is authoritative but may be older than a drag that has not
    // autosaved yet, and a regenerate that reshuffles the picture you were
    // looking at feels like it lost your work. Screen wins; the stored layout
    // fills in whatever was filtered out or has arrived since.
    const onScreen = new Map(
      allNodes.filter((n) => Number.isFinite(n.x) && Number.isFinite(n.y)).map((n) => [n.ul, [n.x, n.y]]),
    );
    snapshot = snap;
    allNodes = (snap?.nodes ?? []).map((n) => ({ ...n }));
    allEdges = (snap?.edges ?? []).map((e) => ({ ...e }));
    seedLayout = { ...(snap?.layout ?? {}), ...Object.fromEntries(onScreen) };
    hidden = new Set([...hidden].filter((ul) => allNodes.some((n) => n.ul === ul)));
    layoutDirty = false;
    $('gv-save-layout').disabled = true;
    // the header tells the truth about the snapshot even when there is
    // nothing to draw (an empty box still has a generation time)
    const s = snap?.stats ?? {};
    $('gv-n-created').textContent = String(s.created ?? 0);
    $('gv-n-seen').textContent = String(s.seen ?? 0);
    $('gv-n-msg').textContent = String(s.msg ?? 0);
    stamp(`generated ${fmtDate(snap?.generatedAt)}`
      + (snap?.layoutSavedAt ? ` · layout ${fmtAgo(snap.layoutSavedAt)}` : '')
      + ` · ${s.users ?? 0} account${s.users === 1 ? '' : 's'}`);
    if (!allNodes.length) { showEmpty(true); return; }
    showEmpty(false);
    rebuild({ fitAfter });
  }

  function rebuild({ fitAfter = false } = {}) {
    resizeCanvas();
    selectNodes();
    buildCards();
    buildSim(seedLayout);
    // the camera must be applied even when nothing moved: the card layer's
    // CSS transform and the canvas transform are only in agreement after this
    applyCamera();
    $('gv-counts').textContent = `${nodes.length} node${nodes.length === 1 ? '' : 's'} · ${edges.length} line${edges.length === 1 ? '' : 's'}`
      + (nodes.length < allNodes.length ? ` of ${allNodes.length}` : '');
    if (capNote) setStatus(capNote, 'error');
    $('gv-save-layout').disabled = !layoutDirty;
    if (fitAfter) requestAnimationFrame(() => fit(false));
    else scheduleDraw();
    if (selected && !byUl.has(selected)) closeInspector();
    else if (selected) renderInspector(selected);
    applyEmphasis();
  }

  function showEmpty(on) {
    $('gv-empty').hidden = !on;
    $('gv-stage').hidden = on;
    $('gv-toolbar').hidden = on;
    if (on) {
      const s = snapshot?.stats;
      $('gv-empty').querySelector('h3').textContent = s?.users
        ? 'This snapshot has no lines to draw'
        : 'The graph has not been generated yet';
    }
  }

  async function load() {
    try {
      const { snapshot: snap } = await api('/api/admin/graph');
      if (!snap) { showEmpty(true); stamp('never generated'); return; }
      adopt(snap, { fitAfter: !hasSavedCamera() });
    } catch (err) {
      setStatus(`God View failed: ${err.message}`, 'error');
    }
  }
  function hasSavedCamera() {
    try { return !!localStorage.getItem(CAM_KEY); } catch { return false; }
  }

  async function generate() {
    const btns = [$('gv-regen'), $('gv-generate')];
    for (const b of btns) { if (b) { b.disabled = true; b.dataset.label = b.textContent; b.textContent = 'Generating…'; } }
    try {
      const { snapshot: snap } = await api('/api/admin/graph', {
        method: 'POST',
        body: JSON.stringify({ keepLayout: $('gv-keep-layout').checked }),
      });
      hitCache.clear();
      adopt(snap, { fitAfter: true });
      setStatus(`Graph regenerated — ${snap.stats.nodes} nodes, ${snap.stats.edges} lines`, 'ok');
    } catch (err) {
      setStatus(`Regenerating the graph failed: ${err.message}`, 'error');
    } finally {
      for (const b of btns) { if (b) { b.disabled = false; b.textContent = b.dataset.label ?? 'Regenerate'; } }
    }
  }

  // ---- inspector ----------------------------------------------------------
  function renderInspector(ul) {
    const n = byUl.get(ul);
    if (!n) return;
    const row = (label, value, cls = '') => `<div class="gv-fact ${cls}"><span>${label}</span><b>${value}</b></div>`;
    const parent = n.ref
      ? `<button class="gv-parent" data-goto="${esc(n.ref)}">${svg('share')}<span>created by <b>@${esc(n.ref)}</b></span></button>`
      : '<p class="dim small-text">No parent — this account was not created from a share link.</p>';
    inspector.innerHTML = `
      <header class="gv-ins-head">
        <span class="gv-ins-av" data-av="${esc(n.ul)}">${esc(n.ul.slice(0, 1))}</span>
        <div class="gv-ins-id">
          <div class="gv-ins-name">${trustMark(n)}<span>@${esc(n.ul)}</span>${n.premium ? `<span class="gv-prem">${svg('star')}</span>` : ''}</div>
          <div class="gv-ins-sub">${n.badge ? `<span class="badge-art" data-art="${esc(n.badge)}" data-px="16"></span>` : ''}
            ${n.gone ? '<span class="dim">account deleted</span>' : `<span class="gv-coco${n.trusted ? ' trusted' : ''}">CoCo ${n.coco ?? 0}${n.trusted ? '<i class="gv-dot"></i>' : ''}</span>`}</div>
        </div>
        <button class="gv-ins-close" data-act="close" title="Close">${svg('close')}</button>
      </header>
      <div class="gv-ins-body">
        ${n.gone ? '<p class="dim small-text">A ghost node: the account is gone, but a child it created still names it as parent.</p>' : `
        <div class="gv-facts">
          ${row('Created', fmtDate(n.createdAt))}
          ${row('Generation', `${n.gen ?? 0}`, 'num')}
          ${row('Downstream', `${n.tree ?? 0}`, 'num')}
          ${row('Invited', `${n.invited ?? 0}`, 'num')}
          ${row('Link opened by', `${n.viewers ?? 0}`, 'num')}
          ${row('Messaged', `${n.sentTo ?? 0} out · ${n.heardFrom ?? 0} in`, 'num')}
          ${row('Vouched', `${n.addedBy ?? 0} added · ${n.verifiedBy ?? 0} verified · ${n.trustedBy ?? 0} trusted`, 'num')}
          ${row('Devices', `${n.devices ?? 0}`, 'num')}
          ${row('App trust', n.verified ? 'verified' : 'unverified', n.verified ? 'ok' : 'bad')}
          ${row('Social', n.trusted ? 'trusted' : 'not yet trusted', n.trusted ? 'ok' : 'bad')}
        </div>`}
        <div class="gv-ins-sec"><h4>Came from</h4>${parent}</div>
        <div class="gv-ins-actions">
          <button class="tiny" data-act="profile" data-ul="${esc(n.ul)}">Open profile</button>
          <button class="tiny" data-act="shares" data-ul="${esc(n.ul)}">Shares</button>
          <button class="tiny" data-act="centre" data-ul="${esc(n.ul)}">Centre</button>
          <button class="tiny" data-act="${n.fx != null ? 'unpin' : 'pin'}" data-ul="${esc(n.ul)}">${n.fx != null ? 'Release' : 'Pin'}</button>
          <button class="tiny danger" data-act="hide" data-ul="${esc(n.ul)}">Hide</button>
        </div>
      </div>`;
    inspector.hidden = false;
    avatarUrl(n.ul).then((url) => {
      if (!url) return;
      const slot = inspector.querySelector('.gv-ins-av');
      if (slot) { slot.style.backgroundImage = `url("${url}")`; slot.textContent = ''; }
    }).catch(() => {});
  }
  function closeInspector() {
    selected = null;
    focus = null;
    inspector.hidden = true;
    inspector.innerHTML = '';
    applyEmphasis();
  }

  // ---- interaction --------------------------------------------------------
  let drag = null; // { mode:'pan'|'node', rect, ... }

  // Anything that should behave like a normal control. Two reasons: none of
  // them may pan or drag the map, and — the subtle one — setPointerCapture on
  // the stage RETARGETS the click that follows pointerup to the stage, so a
  // captured press on a button never reaches the delegated click handler.
  // (That is exactly why the cards' icon links appeared dead.)
  const NO_DRAG = 'button, input, select, textarea, a, .gv-links, .gv-inspector, .gv-hud, .gv-legend';

  function onPointerDown(ev) {
    if (ev.pointerType === 'mouse' && ev.button !== 0) return; // left button only
    if (ev.target.closest?.(NO_DRAG)) return; // let the browser deliver a real click
    // the stage rect is read ONCE per gesture: reading layout inside every
    // pointermove is what turns a smooth drag into a stutter
    const rect = stage.getBoundingClientRect();
    const cardEl = ev.target.closest?.('.gv-card');
    if (cardEl) {
      const ul = cardEl.dataset.ul;
      const n = byUl.get(ul);
      if (!n) return;
      const w = toWorld(ev.clientX - rect.left, ev.clientY - rect.top);
      drag = { mode: 'node', ul, rect, dx: (n.x ?? 0) - w.x, dy: (n.y ?? 0) - w.y, moved: false };
      stage.setPointerCapture(ev.pointerId);
      // NOTE: no preventDefault here — it would swallow the click that a
      // no-move press ends with (cards are user-select:none in CSS instead,
      // which is what actually stops a drag from selecting text)
      return;
    }
    drag = { mode: 'pan', rect, x: ev.clientX, y: ev.clientY, moved: false };
    stage.classList.add('gv-dragging');
    stage.setPointerCapture(ev.pointerId);
  }

  // Opening a ghost (a deleted parent a live account still names) has nowhere
  // to go: say so instead of opening a panel that immediately closes itself.
  function openProfile(ul, tab) {
    if (byUl.get(ul)?.gone) {
      setStatus(`@${ul} no longer exists — it is only in the picture as the parent of accounts it created`, 'error');
      return;
    }
    openUser(ul, tab);
  }

  function onPointerMove(ev) {
    if (!drag) return;
    if (drag.mode === 'pan') {
      const dx = ev.clientX - drag.x;
      const dy = ev.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
      cam = { ...cam, x: cam.x + dx, y: cam.y + dy };
      drag.x = ev.clientX; drag.y = ev.clientY;
      applyCamera();
      return;
    }
    const n = byUl.get(drag.ul);
    if (!n) return;
    drag.moved = true;
    const w = toWorld(ev.clientX - drag.rect.left, ev.clientY - drag.rect.top);
    n.fx = w.x + drag.dx;
    n.fy = w.y + drag.dy;
    n.x = n.fx; n.y = n.fy;
    if (sim && !frozen) sim.alpha(Math.max(sim.alpha(), 0.28)).restart();
    placeCards();
    scheduleDraw();
  }

  function onPointerUp(ev) {
    if (!drag) return;
    const d = drag;
    drag = null;
    stage.classList.remove('gv-dragging');
    try { stage.releasePointerCapture(ev.pointerId); } catch { /* already released */ }
    if (d.mode === 'pan') {
      saveCamera();
      if (!d.moved) { closeInspector(); }  // a click on the backdrop deselects
      return;
    }
    const n = byUl.get(d.ul);
    if (n && !d.moved) {
      // a clean click (no drag): select + light the neighbourhood
      n.fx = n.pinned ? n.x : null;
      n.fy = n.pinned ? n.y : null;
      selectNode(d.ul);
      return;
    }
    if (n) {
      // dropped: stays where it was put (pinned look) until released
      n.pinned = true;
      markLayoutDirty();
      queueLayoutSave();
      applyEmphasis();
      if (selected === d.ul) renderInspector(d.ul); // the Pin button now reads Release
    }
  }

  function selectNode(ul) {
    selected = ul;
    focus = ul;
    renderInspector(ul);
    applyEmphasis();
  }

  function wire() {
    loadCamera();
    stage.addEventListener('pointerdown', onPointerDown);
    stage.addEventListener('pointermove', onPointerMove);
    stage.addEventListener('pointerup', onPointerUp);
    stage.addEventListener('pointercancel', onPointerUp);
    stage.addEventListener('dblclick', (ev) => {
      const cardEl = ev.target.closest?.('.gv-card');
      if (!cardEl) return;
      const n = byUl.get(cardEl.dataset.ul);
      if (!n) return;
      n.pinned = false; n.fx = null; n.fy = null;
      if (sim && !frozen) sim.alpha(0.4).restart();
      markLayoutDirty();
      applyEmphasis();
      ev.preventDefault();
    });
    // hover lights the neighbourhood without selecting
    stage.addEventListener('pointerover', (ev) => {
      if (drag) return;
      const cardEl = ev.target.closest?.('.gv-card');
      const ul = cardEl?.dataset.ul ?? null;
      if (ul === (focus ?? null) || selected) return; // a selection outranks hover
      focus = ul;
      applyEmphasis();
    });
    stage.addEventListener('pointerleave', () => {
      if (selected || drag) return;
      focus = null;
      applyEmphasis();
    });
    stage.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      const rect = stage.getBoundingClientRect();
      // Firefox reports wheel deltas in LINES (deltaMode 1) or pages (2), not
      // pixels: without normalising, a Firefox scroll notch would zoom ~0.5%
      const unitPx = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? 100 : 1;
      // ctrl+wheel (pinch on trackpads) zooms harder, plain wheel zooms gently
      const unit = ev.ctrlKey ? 0.02 : 0.0016;
      zoomAt(ev.clientX - rect.left, ev.clientY - rect.top, Math.exp(-ev.deltaY * unitPx * unit));
    }, { passive: false });

    // card footer icon links + inspector buttons (delegated: cards are rebuilt)
    document.addEventListener('click', (ev) => {
      // NOTE the selector includes [data-goto]: the inspector's "created by"
      // button carries no data-act, and matching on data-act alone made it
      // look dead
      const btn = ev.target.closest?.('[data-act], [data-goto]');
      if (!btn) return;
      if (!stage.contains(btn) && !inspector.contains(btn)) return;
      const ul = btn.dataset.ul;
      const act = btn.dataset.act;
      if (act === 'profile') { openProfile(ul, 'details'); return; }
      if (act === 'shares') { openProfile(ul, 'shares'); return; }
      if (act === 'relations') { openProfile(ul, 'relations'); return; }
      if (act === 'centre') { centreOn(ul); return; }
      if (act === 'close') { closeInspector(); return; }
      if (act === 'pin' || act === 'unpin') {
        const n = byUl.get(ul);
        if (!n) return;
        n.pinned = act === 'pin';
        n.fx = n.pinned ? n.x : null;
        n.fy = n.pinned ? n.y : null;
        if (!n.pinned && sim && !frozen) sim.alpha(0.35).restart();
        markLayoutDirty();
        renderInspector(ul);
        applyEmphasis();
        return;
      }
      if (act === 'hide') {
        hidden.add(ul);
        closeInspector();
        rebuild();
        return;
      }
      const goto = btn.dataset?.goto;
      if (goto) {
        if (!byUl.has(goto)) {
          hidden.delete(goto);
          if (!allNodes.some((n) => n.ul === goto)) { setStatus(`@${goto} is not in this snapshot — regenerate`, 'error'); return; }
          rebuild();
        }
        selectNode(goto);
        centreOn(goto);
      }
    });

    $('gv-regen').addEventListener('click', generate);
    $('gv-generate').addEventListener('click', generate);
    $('gv-save-layout').addEventListener('click', saveLayout);
    $('gv-fit').addEventListener('click', () => fit(true));
    $('gv-zoom-in').addEventListener('click', () => zoomAt(view.w / 2, view.h / 2, 1.35));
    $('gv-zoom-out').addEventListener('click', () => zoomAt(view.w / 2, view.h / 2, 1 / 1.35));
    $('gv-physics').addEventListener('click', (ev) => {
      frozen = !frozen;
      ev.currentTarget.textContent = frozen ? '▶' : '❚❚';
      ev.currentTarget.title = frozen ? 'Resume the layout' : 'Freeze the layout';
      if (frozen) sim?.stop();
      else sim?.alpha(0.4).restart();
    });
    for (const label of document.querySelectorAll('.gv-kind')) {
      label.addEventListener('change', () => {
        kindsOn[label.dataset.kind] = label.querySelector('input').checked;
        rebuild();
      });
    }
    $('gv-hide-loners').addEventListener('change', () => rebuild());
    $('gv-max').addEventListener('change', () => { rebuild(); fit(true); });
    $('gv-search').addEventListener('input', (ev) => {
      query = ev.target.value;
      hitCache.clear();
      applyEmphasis();
    });
    $('gv-search').addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter') return;
      const set = hitSet();
      const first = set ? nodes.find((n) => set.has(n.ul)) : null;
      if (first) { selectNode(first.ul); centreOn(first.ul); }
      else setStatus('No node in this picture matches that name', 'error');
    });
    window.addEventListener('resize', () => { if (!stage.hidden) resizeCanvas(); });
    document.addEventListener('keydown', (ev) => {
      // Escape closes the topmost layer only: app.js owns the user panel and
      // its listener is registered first, so this one steps back when either
      // the panel or the badge modal is open
      if (ev.key === 'Escape' && !inspector.hidden && !stage.hidden
        && $('user-panel').hidden && $('badge-modal').hidden) {
        closeInspector();
        return;
      }
      if (stage.hidden || ev.target.matches?.('input, select, textarea')) return;
      if (ev.key === 'f') fit(true);
      if (ev.key === '+' || ev.key === '=') zoomAt(view.w / 2, view.h / 2, 1.25);
      if (ev.key === '-') zoomAt(view.w / 2, view.h / 2, 1 / 1.25);
    });
  }

  wire();
  return {
    /** Called by the page router when the God View becomes visible. */
    async onShow({ force = false } = {}) {
      resizeCanvas();
      if (!snapshot || force) await load();
      else { applyCamera(); scheduleDraw(); }
    },
    isLoaded: () => !!snapshot,
    /** Escape hatch for tests/ops: drop the in-memory snapshot. */
    reset() {
      if (sim) { sim.stop(); sim = null; } // stopping also clears d3's 1s poke interval
      clearTimeout(saveTimer);
      snapshot = null; seedLayout = null; allNodes = []; allEdges = []; nodes = []; edges = [];
      byUl = new Map(); cards = new Map(); hidden = new Set();
      world.replaceChildren();
      closeInspector();
      showEmpty(true);
    },
    focusUser(ul) {
      if (!byUl.has(ul)) {
        hidden.delete(ul);
        rebuild();
        if (!byUl.has(ul)) return false;
      }
      selectNode(ul);
      centreOn(ul);
      return true;
    },
  };
}
