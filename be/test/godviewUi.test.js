import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// God View front-end logic, headless. The admin panel is a no-build static app
// and CI has no browser, so this drives be/admin/godview.js against a stub DOM
// and the REAL vendored d3-force: the simulation, the camera maths, the canvas
// draw path and every pointer handler actually execute. It exists because two
// bugs in this file were invisible to every other test — d3's forceLink needs
// {source,target} (not the snapshot's {s,t}) and would throw on the first
// build, and the card layer's CSS transform was never applied on load when a
// saved camera existed (edges and cards would disagree about where anything is).

const ADMIN = path.resolve(import.meta.dirname, '..', 'admin');
const D3 = path.join(ADMIN, 'vendor', 'd3');

// ---- globals FIRST --------------------------------------------------------
// d3-timer captures window.requestAnimationFrame when its module body runs, so
// the stub window must exist BEFORE the vendored files are evaluated — that is
// also exactly the browser's order (classic scripts after the document).
let frames = [];
globalThis.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
const flushFrames = (n = 1) => {
  for (let i = 0; i < n; i++) {
    const q = frames;
    frames = [];
    for (const fn of q) fn(performance.now() + i * 16);
  }
};
globalThis.performance = globalThis.performance ?? { now: () => Date.now() };
globalThis.localStorage = {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
  setItem(k, v) { this._m.set(k, String(v)); },
  removeItem(k) { this._m.delete(k); },
};
globalThis.CSS = { escape: (s) => s };

const captures = []; // every setPointerCapture call (see the card-link test)

// ---- minimal DOM ----------------------------------------------------------
// innerHTML is not parsed (no parser here): assigning it creates ONE synthetic
// child, which is enough for the firstElementChild/querySelector paths.
function makeEl(tag = 'div', id = '') {
  const node = {
    tagName: tag.toUpperCase(),
    id,
    style: {},
    dataset: {},
    hidden: false,
    disabled: false,
    checked: false,
    value: '',
    _text: '',
    children: [],
    parentNode: null,
    isFragment: false,
    _html: '',
    _listeners: new Map(),
    classList: {
      _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); },
      toggle(c, on) {
        if (on === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); }
        else if (on) this._s.add(c);
        else this._s.delete(c);
        return this._s.has(c);
      },
      contains(c) { return this._s.has(c); },
    },
    get innerHTML() { return this._html; },
    set innerHTML(v) {
      this._html = String(v);
      this.children = String(v).trim() ? [makeEl('div')] : [];
      for (const c of this.children) c.parentNode = node;
    },
    // a browser stringifies textContent on assignment; the stub must too or
    // number assignments look fine here and different in the panel
    get textContent() { return this._text; },
    set textContent(v) { this._text = v === null || v === undefined ? '' : String(v); },
    get firstElementChild() { return this.children[0] ?? null; },
    append(...kids) {
      for (const k of kids) {
        if (k?.isFragment) this.children.push(...k.children);
        else this.children.push(k);
      }
    },
    replaceChildren(...kids) { this.children = []; this.append(...kids); },
    querySelector() { const c = makeEl('div'); c.parentNode = node; return c; },
    querySelectorAll() { return []; },
    closest() { return null; },
    matches() { return false; },
    // a real browser answers true for a button inside the stage; the stub has
    // no tree, so anything that looks like one of our buttons is "inside"
    contains(other) { return this.children.includes(other) || !!other?.dataset?.act || !!other?.dataset?.goto; },
    addEventListener(type, fn) {
      if (!this._listeners.has(type)) this._listeners.set(type, []);
      this._listeners.get(type).push(fn);
    },
    dispatch(type, ev = {}) {
      for (const fn of this._listeners.get(type) ?? []) {
        fn({ preventDefault() {}, stopPropagation() {}, target: node, currentTarget: node, ...ev });
      }
    },
    setPointerCapture(id) { captures.push(id); },
    releasePointerCapture() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 700, right: 1200, bottom: 700 }),
    getContext: () => ctxStub,
    focus() {},
  };
  return node;
}
// records what the edge layer paints, so the draw path is assertable.
// The line's colour + dash pattern are sampled at stroke() time: the code
// resets the dash before filling each arrowhead, so sampling at setLineDash()
// would count that reset as another "solid line".
const drawn = { strokes: [], fills: [] };
const resetDrawn = () => { drawn.strokes.length = 0; drawn.fills.length = 0; };
const ctxStub = {
  canvas: { width: 2400, height: 1400 },
  _stroke: '', _fill: '', _dash: [], _blur: 0,
  setTransform() {}, clearRect() {}, save() {}, restore() {},
  set strokeStyle(v) { this._stroke = v; },
  set lineWidth(v) { this._lw = v; },
  setLineDash(d) { this._dash = d; },
  set shadowBlur(v) { this._blur = v; },
  set fillStyle(v) { this._fill = v; },
  beginPath() {},
  moveTo() {}, lineTo() {}, quadraticCurveTo() {}, closePath() {},
  stroke() { drawn.strokes.push({ color: this._stroke, dash: this._dash.length ? 'dash' : 'solid', glow: this._blur > 0 }); },
  fill() { drawn.fills.push(this._fill); },
};

const els = new Map();
const byId = (id) => { if (!els.has(id)) els.set(id, makeEl('div', id)); return els.get(id); };
const mainEl = makeEl('main');
globalThis.document = {
  getElementById: byId,
  createElement: (t) => makeEl(t),
  createDocumentFragment: () => { const f = makeEl('fragment'); f.isFragment = true; return f; },
  querySelector: (sel) => (sel === '.admin-main' ? mainEl : makeEl('main')),
  querySelectorAll: () => [],
  _listeners: new Map(),
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  },
  dispatch(type, ev = {}) {
    for (const fn of this._listeners.get(type) ?? []) fn({ preventDefault() {}, stopPropagation() {}, ...ev });
  },
  documentElement: makeEl('html'),
};
globalThis.window = {
  devicePixelRatio: 2,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  addEventListener() {},
};

// The UMD builds merge into the global `d3` and must load in dependency order
// (index.html does the same, as classic scripts, before the module scripts).
for (const f of ['d3-dispatch.min.js', 'd3-quadtree.min.js', 'd3-timer.min.js', 'd3-force.min.js']) {
  new Function(readFileSync(path.join(D3, f), 'utf8')).call(globalThis);
}
assert.ok(globalThis.d3?.forceSimulation, 'vendored d3-force exposes the simulation');
globalThis.window.d3 = globalThis.d3;
// prove the physics is driven by OUR frame pump, not real timers: a timer that
// ran on setTimeout would make every assertion below depend on wall-clock luck
{
  let probeTicks = 0;
  const probe = globalThis.d3.forceSimulation([{ id: 'p' }]).on('tick', () => { probeTicks += 1; });
  assert.equal(probeTicks, 0, 'd3 must not tick before a frame is pumped');
  flushFrames(3);
  assert.ok(probeTicks > 0, 'd3 ticks through the stubbed requestAnimationFrame');
  probe.stop();
  // IMPORTANT: drain whatever d3-timer still has queued. Dropping a pending
  // wake leaves its internal "a frame is scheduled" flag set, and the NEXT
  // simulation then never ticks at all — a stall that looks exactly like a
  // bug in the page.
  flushFrames(10);
  assert.equal(frames.length, 0, 'the frame queue is empty before the real graph loads');
}

// ---- fixture: the shape POST /api/admin/graph returns --------------------
const NODE = (ul, over = {}) => ({
  ul, u: ul, verified: false, premium: false, badge: null, badges: [], coco: 0, trusted: false,
  addedBy: 0, verifiedBy: 0, trustedBy: 0, createdAt: '2026-10-10T08:00:00.000Z', devices: 1,
  hasAvatar: false, ref: null, refAt: null, gone: false, gen: 0, tree: 0, invited: 0,
  viewers: 0, sentTo: 0, heardFrom: 0, ...over,
});
const snapshot = {
  generatedAt: '2026-10-10T09:00:00.000Z',
  layoutSavedAt: null,
  layout: null,
  stats: { users: 4, ghosts: 1, nodes: 5, edges: 8, created: 3, seen: 2, msg: 3, deepest: 2 },
  nodes: [
    NODE('alice', { verified: true, premium: true, badge: 'premium', badges: ['premium'], coco: 12, trusted: true, hasAvatar: true, gen: 0, tree: 2, invited: 2, viewers: 1, sentTo: 1, heardFrom: 1 }),
    NODE('bobby', { ref: 'alice', refAt: '2026-10-10T08:10:00.000Z', gen: 1, tree: 1, invited: 1, sentTo: 1, heardFrom: 1 }),
    NODE('cyrus', { ref: 'bobby', gen: 2, viewers: 1, heardFrom: 1 }),
    NODE('mentor', { gone: true, devices: 0, createdAt: null, invited: 1, tree: 1 }),
    NODE('pupil', { ref: 'mentor', gen: 1, sentTo: 1 }),
  ],
  edges: [
    { s: 'alice', t: 'bobby', k: 'created', n: 1, at: null },
    { s: 'bobby', t: 'cyrus', k: 'created', n: 1, at: null },
    { s: 'mentor', t: 'pupil', k: 'created', n: 1, at: null },
    { s: 'cyrus', t: 'alice', k: 'seen', n: 2, at: null },
    { s: 'alice', t: 'cyrus', k: 'seen', n: 1, at: null },
    { s: 'alice', t: 'bobby', k: 'msg', n: 4, at: null },
    { s: 'bobby', t: 'alice', k: 'msg', n: 2, at: null },
    { s: 'pupil', t: 'alice', k: 'msg', n: 1, at: null },
  ],
};

const calls = [];
let layoutPuts = [];
// what the fake server hands back — swappable so one test can serve a huge graph
let served = snapshot;
const deps = {
  api: async (p, opts = {}) => {
    calls.push(`${opts.method ?? 'GET'} ${p}`);
    if (p === '/api/admin/graph/layout') { layoutPuts.push(JSON.parse(opts.body).positions); return { saved: 5 }; }
    if (p === '/api/admin/graph') return { snapshot: JSON.parse(JSON.stringify(served)) };
    return {};
  },
  esc: (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
  fmtDate: (v) => (v ? new Date(v).toLocaleString() : '—'),
  fmtAgo: () => 'just now',
  avatarUrl: async (ul) => (ul === 'alice' ? 'blob:avatar' : null),
  openUser: (ul, tab) => calls.push(`openUser:${ul}:${tab}`),
  setStatus: (msg, kind) => calls.push(`status:${kind ?? 'info'}:${msg}`),
};

// index.html's initial control state
byId('gv-max').value = '400';
byId('gv-hide-loners').checked = false;
byId('gv-keep-layout').checked = true;
byId('gv-search').value = '';


const stage = byId('gv-stage');
const world = byId('gv-world');
const inspector = byId('gv-inspector');
// a pointer target that answers closest() the way the real DOM would: `card`
// is the .gv-card under the pointer, `act` the [data-act] button (which is
// also what the NO_DRAG selector's `button` matches)
const target = ({ card = null, act = null, gotoUl = null } = {}) => ({
  closest: (sel) => {
    if (sel === '.gv-card') return card ? { dataset: { ul: card } } : null;
    // the delegated handler matches BOTH selectors: the inspector's parent
    // button carries data-goto and no data-act
    if (sel.includes('[data-act]') || sel.includes('button')) {
      return act ?? (gotoUl ? { dataset: { goto: gotoUl } } : null);
    }
    return null;
  },
});
const cardTarget = (ul) => target({ card: ul });
const bgTarget = target();
// run every queued frame until the pump is empty: this is what lets d3's own
// wake callback execute the cleanup it owes (clearing its 1s interval)
const drain = (rounds = 12) => { for (let i = 0; i < rounds && frames.length; i++) flushFrames(1); };
const cam = () => JSON.parse(localStorage.getItem('cocono.admin.godview.camera'));
// the ghost-node explanation is an EXPECTED error status (asserted on its own
// below), so it is not counted as a failure by the generic "no errors" checks
const errors = () => calls.filter((c) => c.startsWith('status:error') && !c.includes('no longer exists'));

const { initGodView } = await import(path.join(ADMIN, 'godview.js'));
const gv = initGodView(deps);

test('god view: loads the stored snapshot and lays the graph out', async () => {
  await gv.onShow();
  flushFrames(300); // run the simulation to a settle

  assert.deepEqual(calls.slice(0, 1), ['GET /api/admin/graph'], 'opening the page NEVER regenerates');
  assert.equal(byId('gv-counts').textContent, '5 nodes · 8 lines');
  assert.equal(byId('gv-n-created').textContent, '3');
  assert.equal(byId('gv-n-seen').textContent, '2');
  assert.equal(byId('gv-n-msg').textContent, '3');
  assert.match(byId('gv-stamp').textContent, /generated .* · 4 accounts/);
  assert.equal(byId('gv-empty').hidden, true, 'the stage replaces the empty state');
  assert.equal(stage.hidden, false);

  // one card per node, each placed by the simulation
  assert.equal(world.children.length, 5);
  for (const card of world.children) {
    assert.match(card.style.transform ?? '', /translate3d\(-?[\d.]+px, -?[\d.]+px, 0\)/, 'every card has a position');
  }
  assert.ok(drawn.strokes.length >= 8, 'the edge layer painted while the layout settled');

  // the card layer and the canvas share ONE camera transform
  assert.match(world.style.transform, /^translate\(-?[\d.]+px, -?[\d.]+px\) scale\([\d.]+\)$/);
  const c = cam();
  assert.ok(c.k > 0 && Number.isFinite(c.x) && Number.isFinite(c.y), 'the camera is persisted');

  // a settled layout is saved back to the snapshot (debounced)
  await new Promise((r) => setTimeout(r, 1600));
  assert.equal(layoutPuts.length, 1, 'the settled layout autosaves once');
  assert.deepEqual(Object.keys(layoutPuts[0]).sort(), ['alice', 'bobby', 'cyrus', 'mentor', 'pupil']);
  assert.ok(layoutPuts[0].alice.every(Number.isFinite));
  assert.equal(byId('gv-save-layout').disabled, true, 'the save button rests once stored');

  // ONE controlled frame: every visible edge is drawn exactly once, each with
  // its own colour and an arrowhead (directionality), and a camera change is
  // enough to trigger the repaint
  resetDrawn();
  byId('gv-zoom-in').dispatch('click');
  flushFrames(1);
  // a frame may be painted more than once here (a leftover queued frame plus
  // the camera's own repaint), so assert per-frame ratios, not absolutes
  const painted = drawn.strokes.length / 8;
  assert.ok(Number.isInteger(painted) && painted >= 1, `all 8 edges stroked (got ${drawn.strokes.length})`);
  assert.equal(drawn.fills.length, drawn.strokes.length, 'every edge ends in an arrowhead: all 8 are directed');
  assert.deepEqual([...new Set(drawn.strokes.map((s) => s.color))].sort(), ['#2fb3a5', '#6c5fd0', '#8f7cf0'],
    'created/seen/msg each get their own colour');
  assert.deepEqual([...new Set(drawn.fills)].sort(), ['#2fb3a5', '#6c5fd0', '#8f7cf0'],
    'arrowheads match their line');
  const kind = (color, dash) => drawn.strokes.filter((s) => s.color === color && s.dash === dash).length;
  assert.equal(kind('#8f7cf0', 'solid'), 3 * painted, 'created: SOLID brand purple');
  assert.equal(kind('#6c5fd0', 'dash'), 2 * painted, 'seen: DOTTED dark purple');
  assert.equal(kind('#2fb3a5', 'dash'), 3 * painted, 'messaged: DASHED teal');
  assert.ok(drawn.strokes.some((s) => s.glow), 'the created edges carry a glow');
  assert.equal(errors().length, 0, `no error status: ${errors().join(' | ')}`);
});

test('god view: camera, selection, drag and the card links all work', async () => {
  await gv.onShow();
  flushFrames(60);
  calls.length = 0;
  layoutPuts = [];

  // zoom buttons + wheel keep the point under the cursor fixed
  const before = cam();
  byId('gv-zoom-in').dispatch('click');
  assert.ok(cam().k > before.k, 'zoom in raises k');
  stage.dispatch('wheel', { clientX: 600, clientY: 300, deltaY: 300, target: bgTarget });
  assert.ok(cam().k < before.k * 1.4, 'wheel down zooms out');

  // pan moves the camera and saves it
  const p0 = cam();
  stage.dispatch('pointerdown', { pointerId: 1, clientX: 100, clientY: 100, target: bgTarget });
  stage.dispatch('pointermove', { pointerId: 1, clientX: 180, clientY: 150, target: bgTarget });
  stage.dispatch('pointerup', { pointerId: 1, clientX: 180, clientY: 150, target: bgTarget });
  assert.equal(cam().x, p0.x + 80, 'panning translates the camera by the pointer delta');
  assert.equal(cam().y, p0.y + 50);

  // a click on a card selects it and lights its neighbourhood
  stage.dispatch('pointerdown', { pointerId: 2, clientX: 400, clientY: 400, target: cardTarget('bobby') });
  stage.dispatch('pointerup', { pointerId: 2, clientX: 400, clientY: 400, target: cardTarget('bobby') });
  assert.equal(inspector.hidden, false, 'the inspector opens');
  assert.match(inspector.innerHTML, /@bobby/, 'it describes the selected node');
  assert.match(inspector.innerHTML, /created by <b>@alice<\/b>/, 'and its parent');
  assert.match(inspector.innerHTML, /CoCo 0/, 'and its coco score');

  // dragging a card moves AND pins that node
  const card = world.children.find((c) => c.dataset.ul === 'bobby');
  const at0 = card.style.transform;
  stage.dispatch('pointerdown', { pointerId: 3, clientX: 500, clientY: 300, target: cardTarget('bobby') });
  stage.dispatch('pointermove', { pointerId: 3, clientX: 560, clientY: 340, target: cardTarget('bobby') });
  stage.dispatch('pointerup', { pointerId: 3, clientX: 560, clientY: 340, target: cardTarget('bobby') });
  assert.notEqual(card.style.transform, at0, 'the dragged card moved');
  assert.match(inspector.innerHTML, /Release/, 'a dropped node offers to be released');

  // the card's icon links open the matching user-panel tab. Pressing one must
  // NOT start a drag: pointer capture on the stage would retarget the click
  // that follows and the button would silently do nothing (a real bug this
  // guards against)
  const linkBtn = { dataset: { act: 'shares', ul: 'alice' } };
  const linkTarget = target({ card: 'alice', act: linkBtn });
  const camBeforeLinks = cam();
  captures.length = 0;
  stage.dispatch('pointerdown', { pointerId: 9, clientX: 200, clientY: 200, target: linkTarget });
  assert.equal(captures.length, 0,
    'pressing a card link must NOT capture the pointer — capture retargets the click to the stage and the button dies');
  stage.dispatch('pointermove', { pointerId: 9, clientX: 260, clientY: 250, target: linkTarget });
  stage.dispatch('pointerup', { pointerId: 9, clientX: 260, clientY: 250, target: linkTarget });
  assert.deepEqual(cam(), camBeforeLinks, 'pressing a card link never pans the map');
  document.dispatch('click', { target: linkTarget });
  assert.ok(calls.includes('openUser:alice:shares'), 'the shares link opens the Shares tab');

  document.dispatch('click', { target: target({ card: 'cyrus', act: { dataset: { act: 'relations', ul: 'cyrus' } } }) });
  assert.ok(calls.includes('openUser:cyrus:relations'), 'the relations link opens that tab');
  document.dispatch('click', { target: target({ card: 'bobby', act: { dataset: { act: 'profile', ul: 'bobby' } } }) });
  assert.ok(calls.includes('openUser:bobby:details'), 'the profile link opens Details');

  // the inspector's "created by" button jumps to the parent node (it carries
  // data-goto and NO data-act — a selector that only matched data-act left it
  // silently dead)
  document.dispatch('click', { target: target({ gotoUl: 'alice' }) });
  assert.match(inspector.innerHTML, /@alice/, 'the parent button selects the parent');

  // a ghost node has no panel to open: it says so instead of flashing one
  const callsBefore = calls.length;
  document.dispatch('click', { target: target({ card: 'mentor', act: { dataset: { act: 'profile', ul: 'mentor' } } }) });
  assert.ok(calls.slice(callsBefore).some((c) => c.startsWith('status:error') && c.includes('no longer exists')),
    'a deleted parent explains itself rather than opening an empty panel');
  assert.ok(!calls.some((c) => c === 'openUser:mentor:details'));

  // a backdrop click deselects
  stage.dispatch('pointerdown', { pointerId: 4, clientX: 5, clientY: 5, target: bgTarget });
  stage.dispatch('pointerup', { pointerId: 4, clientX: 5, clientY: 5, target: bgTarget });
  assert.equal(inspector.hidden, true);

  // search marks matches and Enter centres one
  byId('gv-search').value = 'cyr';
  byId('gv-search').dispatch('input', { target: byId('gv-search') });
  byId('gv-search').dispatch('keydown', { key: 'Enter', target: byId('gv-search') });
  flushFrames(30);
  assert.equal(errors().length, 0, `no error status: ${errors().join(' | ')}`);

  // filters rebuild without losing the picture
  byId('gv-hide-loners').checked = true;
  byId('gv-hide-loners').dispatch('change');
  assert.match(byId('gv-counts').textContent, /^\d+ nodes? · \d+ lines?/);
  byId('gv-max').value = '2';
  byId('gv-max').dispatch('change');
  flushFrames(20);
  assert.match(byId('gv-counts').textContent, /^2 nodes · \d+ lines of 5$/, 'the cap says what it kept');

  // regenerate is an explicit POST
  byId('gv-regen').dispatch('click');
  await new Promise((r) => setTimeout(r, 20));
  flushFrames(10);
  assert.ok(calls.includes('POST /api/admin/graph'), 'regenerating posts');
  assert.ok(calls.some((c) => c.startsWith('status:ok:Graph regenerated')), 'and reports the result');
  assert.equal(errors().length, 0, `no unexpected error status: ${errors().join(' | ')}`);
});

test('god view: teardown stops the simulation (no leaked d3 timer)', () => {
  gv.reset();
  drain();
  assert.equal(world.children.length, 0, 'the card layer is emptied');
  assert.equal(byId('gv-empty').hidden, false, 'and the empty state returns');
});

test('god view: a huge snapshot is capped instead of freezing the browser', async () => {
  // nodes are real DOM cards: 5000 of them would look like a hang, so the
  // safety net behind the toolbar cap must kick in AND say what it did
  const many = {
    ...snapshot,
    stats: { ...snapshot.stats, users: 2000, nodes: 2000 },
    nodes: Array.from({ length: 2000 }, (_, i) => NODE(`user${String(i).padStart(4, '0')}`, {
      invited: i % 7, sentTo: i % 3, heardFrom: i % 5,
    })),
    edges: [],
  };
  served = many;
  byId('gv-max').value = '0';            // "all" — exactly the footgun
  byId('gv-hide-loners').checked = false;
  calls.length = 0;
  try {
    await gv.onShow({ force: true });
    flushFrames(2);
    assert.match(byId('gv-counts').textContent, /^1500 nodes · 0 lines of 2000$/,
      `capped, and honest about it: "${byId('gv-counts').textContent}"`);
    assert.equal(world.children.length, 1500, 'only that many cards were built');
    assert.ok(calls.some((c) => c.startsWith('status:error') && c.includes('most connected')),
      'the operator is told the picture was trimmed');
  } finally {
    served = snapshot;
    byId('gv-max').value = '400';
    gv.reset();
    drain();
  }
});

test('god view: leaves no timer running (CI must not hang on this file)', async () => {
  // d3-timer keeps a 1s poke interval alive while a simulation is pending, and
  // only clears it from inside its own wake callback. reset() stops the sim,
  // but the wake that does the clearing is still queued — so a stub that stops
  // pumping frames (this file) would hang forever where a browser would not.
  // Drain, then assert the process has nothing left to wait for.
  gv.reset();
  drain();
  await new Promise((r) => setTimeout(r, 30));
  const alive = process.getActiveResourcesInfo().filter((r) => r === 'Timeout');
  assert.deepEqual(alive, [], `leaked timer(s): ${alive.length} — a stopped simulation must release d3's poke interval`);
});
