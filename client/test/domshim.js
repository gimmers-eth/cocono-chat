// A minimal DOM stand-in, enough to RUN the app's media painting code (bubble
// nodes, tab panels, the viewer and its control row) under `node --test`.
//
// Why: there is no browser here and no jsdom dependency, and the media UI is
// exactly the layer static guards cannot reach — graph.test.js proves it parses,
// mediaui.test.js proves its ids exist, neither proves that a pending file
// bubble carries BOTH buttons, that an unverified sender's photo arrives
// blurred, or that clicking Keep persists keep:true. With this ~200-line shim
// those become real tests instead of a manual-smoke line.
//
// It is NOT a DOM: no layout, no CSS, no event bubbling (listeners fire on the
// node you call .fire()/.click() on, which is all these modules need), and
// selectors are '.class' / 'tag' only. Elements come from REAL markup: pass the
// text of index.html and #id lookups resolve against the ids it declares.

class TextNode {
  constructor(text) { this.nodeType = 3; this._text = String(text ?? ''); }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v ?? ''); }
}

class El {
  constructor(tag) {
    this.nodeType = 1;
    this._tag = String(tag).toLowerCase();
    this.tagName = this._tag.toUpperCase();
    this.childNodes = [];
    this.parentNode = null;
    this.dataset = {};
    this.style = {};
    this.attrs = {};
    this.listeners = {};
    this._classes = new Set();
    this._text = '';
    // the properties the media code touches (declared so tests can assert them)
    this.src = '';
    this.href = '';
    this.type = '';
    this.value = '';
    this.title = '';
    this.alt = '';
    this.placeholder = '';
    this.target = '';
    this.rel = '';
    this.maxLength = 0;
    this.autocomplete = '';
    this.spellcheck = true;
    this.decoding = '';
    this.preload = '';
    this.poster = '';
    this.playsInline = false;
    this.muted = false;
    this.paused = true;
    this.disabled = false;
    this.hidden = false;
    this.files = [];
    this.readyState = 4;
  }

  get className() { return [...this._classes].join(' '); }
  set className(v) { this._classes = new Set(String(v ?? '').split(/\s+/).filter(Boolean)); }

  get classList() {
    const set = this._classes;
    return {
      add: (...c) => c.forEach((x) => set.add(x)),
      remove: (...c) => c.forEach((x) => set.delete(x)),
      contains: (c) => set.has(c),
      toggle: (c, force) => {
        const on = force === undefined ? !set.has(c) : !!force;
        if (on) set.add(c); else set.delete(c);
        return on;
      },
    };
  }

  get children() { return this.childNodes.filter((node) => node instanceof El); }

  append(...nodes) {
    for (const node of nodes) {
      if (node === null || node === undefined) continue;
      if (node._fragment) { this.childNodes.push(...node.childNodes); node.childNodes = []; }
      else this.childNodes.push(node);
      if (node instanceof El) node.parentNode = this;
    }
  }

  replaceChildren(...nodes) {
    this.childNodes = [];
    this.append(...nodes);
  }

  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  // the UI genuinely removes attributes (the lightbox drops its src on close,
  // so a stale picture cannot flash on the next open) — the shim must have it
  removeAttribute(k) { delete this.attrs[k]; }

  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn); }

  // a click as the media code uses it: the event carries a target, and
  // stopPropagation is real (the Files row's Download must not also open the
  // viewer)
  fire(type = 'click', init = {}) {
    const event = {
      type,
      target: init.target ?? this,
      stopPropagation() { event._stopped = true; },
      preventDefault() { event._prevented = true; },
      ...init,
    };
    for (const fn of [...(this.listeners[type] ?? [])]) fn(event);
    return event;
  }

  click() { return this.fire('click'); }

  set textContent(v) {
    this._text = String(v ?? '');
    if (this._text === '') this.childNodes = [];
  }

  get textContent() {
    return this._text + this.childNodes.map((node) => node.textContent ?? '').join(' ');
  }

  matches(sel) {
    return sel.split(',').map((s) => s.trim()).some((s) => (s.startsWith('.')
      ? this._classes.has(s.slice(1))
      : s.startsWith('#') ? this.attrs.id === s.slice(1) : this._tag === s));
  }

  descendants() {
    const out = [];
    const walk = (node) => { for (const child of node.children) { out.push(child); walk(child); } };
    walk(this);
    return out;
  }

  querySelector(sel) { return this.descendants().find((d) => d.matches(sel)) ?? null; }
  querySelectorAll(sel) { return this.descendants().filter((d) => d.matches(sel)); }

  closest(sel) {
    let node = this;
    while (node) {
      if (node.matches?.(sel)) return node;
      node = node.parentNode;
    }
    return null;
  }

  contains(other) { return other === this || this.descendants().includes(other); }

  // media surface
  play() { this.paused = false; this.fire('play'); return Promise.resolve(); }
  pause() { this.paused = true; this.fire('pause'); }
  focus() {}
  blur() {}

  // real cleanup (a download anchor detaches itself after the click; a
  // dangling node here would mean the app leaked one into <body>)
  remove() {
    const siblings = this.parentNode?.childNodes;
    if (siblings) {
      const i = siblings.indexOf(this);
      if (i >= 0) siblings.splice(i, 1);
    }
    this.parentNode = null;
  }

  // <input type=file>: a test assigns files then fires 'change'
  setFiles(...blobs) { this.files = blobs; }
}

export function installDomShim(indexHtml = '') {
  const declaredIds = new Set([...indexHtml.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const registry = new Map();
  const revoked = [];
  const created = [];
  let urlSeq = 0;

  const byId = (id) => {
    if (!registry.has(id)) {
      const el = new El(declaredIds.has(id) ? 'div' : 'missing');
      el.attrs.id = id;
      el._declared = declaredIds.has(id);
      registry.set(id, el);
    }
    return registry.get(id);
  };

  globalThis.document = {
    createElement(tag) { const el = new El(tag); created.push(el); return el; },
    createDocumentFragment() { const frag = new El('fragment'); frag._fragment = true; return frag; },
    createTextNode: (text) => new TextNode(text),
    // the ids come from REAL markup: an element the app looks up that index.html
    // does not declare shows up as a MISSING node (and _declared === false), so a
    // renamed id fails these tests instead of silently no-oping
    getElementById: byId,
    body: new El('body'),
    documentElement: new El('html'),
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    visibilityState: 'visible',
    hasFocus: () => true,
    execCommand: () => true,
  };

  globalThis.URL = Object.assign(globalThis.URL ?? function () {}, {
    createObjectURL: () => `blob:local/${++urlSeq}`,
    revokeObjectURL: (url) => { revoked.push(url); },
  });

  globalThis.window ??= { dispatchEvent() {}, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false }) };
  globalThis.Event ??= class { constructor(type) { this.type = type; } };
  globalThis.CustomEvent ??= class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
  const mem = new Map();
  globalThis.localStorage ??= {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => mem.delete(k),
  };
  globalThis.navigator ??= { onLine: true, userAgent: 'node' };
  globalThis.matchMedia ??= () => ({ matches: false });

  return {
    byId,
    registry,
    revoked,
    created,
    declaredIds,
    reset() {
      registry.clear();
      revoked.length = 0;
      created.length = 0;
    },
  };
}

export { El, TextNode };
