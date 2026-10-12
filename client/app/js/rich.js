// PURE text intelligence for the chat surfaces: @-mentions and links.
// No DOM, no store, no network — so the parsing rules (which usernames
// count, what reads as a URL, how the mention search orders its three
// slots) are unit-testable in Node and shared by the composer popup, the
// transcript bubbles, the message modal and the Links tab (via media.js).
//
// MENTIONS: the wire format is plain text — a sender types " @username "
// (what the composer's @-search inserts). The RECEIVER decides how it
// renders: a token becomes a user component only if THIS device knows
// that user (friends mirror / self / the open chat), so someone sending a
// name they never added still renders as a known user for a recipient who
// has. Unknown @tokens stay plain text (a stranger's name is not a person
// record here, and inventing one would fake the trust icon).
//
// LINKS: http(s) URLs with a scheme, plus BARE hosts ("example.com/x") —
// the scheme is not required to recognise a link, only to be clicked it
// gains "https://". Bare domains only count when they end in a KNOWN TLD:
// messages say "v1.2", "photo.jpg" and "e.g." constantly, and linkifying
// those on every render is worse than missing an exotic ccTLD. Trailing
// punctuation is prose, not part of the link.

// Server rules (be/src/lib/username.js) — a username that cannot exist
// can never be a mention.
export const USERNAME_RE = /^[a-zA-Z0-9_-]{4,64}$/;

// The TLD allowlist for scheme-less links. Lowercase; matched case-insensitively.
const TLDS = [
  // generic + legacy
  'com', 'net', 'org', 'edu', 'gov', 'mil', 'int', 'info', 'biz', 'name', 'pro', 'aero', 'coop', 'museum',
  // popular new gTLDs
  'app', 'dev', 'ai', 'cloud', 'xyz', 'online', 'site', 'wiki', 'live', 'shop', 'store', 'link', 'news',
  'media', 'tech', 'digital', 'email', 'page', 'space', 'website', 'club', 'network', 'systems', 'agency',
  'studio', 'design', 'photo', 'video', 'music', 'games', 'chat', 'fun', 'life', 'world', 'today', 'blog',
  'agency', 'academy', 'social', 'team', 'expert', 'mail',
  // ccTLDs (short list: what people actually paste into chat)
  'us', 'uk', 'ca', 'au', 'nz', 'ie', 'in', 'pk', 'bd', 'cn', 'jp', 'kr', 'tw', 'hk', 'sg', 'my', 'id',
  'th', 'vn', 'ph', 'au', 'za', 'ke', 'ng', 'eg', 'ma', 'il', 'ae', 'sa', 'tr', 'ir',
  'de', 'fr', 'es', 'it', 'nl', 'be', 'at', 'ch', 'se', 'no', 'dk', 'fi', 'is', 'pl', 'cz', 'sk', 'hu',
  'ro', 'bg', 'hr', 'si', 'ba', 'rs', 'me', 'mk', 'al', 'gr', 'pt', 'ru', 'ua', 'by', 'ee', 'lv', 'lt',
  'io', 'co', 'cc', 'tv', 'fm', 'am', 'so', 'gs', 'sh', 'ly', 'to', 'gg', 'im', 'ac', 'eu',
];

// One scanner for all three token kinds. Alternation order = precedence at
// the same start position: scheme URL before bare host (so the host inside
// "https://x.y/z" is never scanned twice), mentions before anything text.
const TOKEN_RE = new RegExp(
  [
    // @mention candidate: not glued to a word char / URL path, 4-64 valid chars
    String.raw`(?<mention>(?<![\w./-])@[a-zA-Z0-9_-]{4,64})`,
    // explicit scheme URL
    String.raw`(?<scheme>https?:\/\/[^\s<>"'\x60]+)`,
    // bare host + known TLD, optional :port and path
    String.raw`(?<bare>(?<![\w.@:/-])(?:[\w-]+\.)+(?:${TLDS.join('|')})(?![\w-])(?::\d+)?(?:[/?#][^\s<>"'\x60]*)?)`,
  ].join('|'),
  'gi',
);

// trailing punctuation is prose, not part of the link (kept for every match)
function trimTail(url) {
  return url.replace(/[),.;!?*:]+$/, '');
}

/** Scheme to open a detected link with: as-is when explicit, else https. */
export function linkHref(url) {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

/** Validate + normalise one regex match into a link record (or null). */
function linkRecord(raw) {
  const url = trimTail(raw);
  if (!url) return null;
  let host = '';
  try { host = new URL(linkHref(url)).hostname; } catch { return null; }
  // a single-label "host" is not a site (and URL() happily invents one from
  // odd input) — every real domain has a dot
  if (!host || !host.includes('.')) return null;
  return { url, host, href: linkHref(url) };
}

/**
 * Split message text into renderable runs, in order. `isKnown(name)`
 * decides which @tokens are people THIS device knows; unknown tokens come
 * back as plain 'text' runs (possibly several — consecutive text/unknown
 * runs are merged so painters never see mention-shaped noise).
 */
export function splitRich(text, isKnown = () => false) {
  const src = String(text ?? '');
  const out = [];
  let last = 0;
  const pushText = (chunk) => {
    if (!chunk) return;
    const prev = out[out.length - 1];
    if (prev && prev.kind === 'text') prev.text += chunk;
    else out.push({ kind: 'text', text: chunk });
  };
  for (const m of src.matchAll(TOKEN_RE)) {
    const start = m.index;
    if (start < last) continue; // an inner alternative already consumed it
    const g = m.groups;
    let token = null;
    if (g.scheme) {
      const rec = linkRecord(g.scheme);
      if (rec) token = { kind: 'link', text: rec.url, ...rec };
    } else if (g.bare) {
      // a bare host glued to the mention we just took is part of it, not a site
      const rec = linkRecord(g.bare);
      if (rec) token = { kind: 'link', text: rec.url, ...rec };
    } else if (g.mention) {
      const name = g.mention.slice(1).toLowerCase();
      if (USERNAME_RE.test(name) && isKnown(name)) {
        token = { kind: 'mention', text: g.mention, name };
      }
    }
    if (!token) continue; // rejected match: stays plain text with the runs around it
    pushText(src.slice(last, start));
    out.push(token);
    last = start + token.text.length;
  }
  pushText(src.slice(last));
  return out;
}

/** One entry per URL in a message, in order, de-duplicated per message.
 *  Mentions never leak in (links only); {url, host, href}. */
export function extractLinks(text) {
  const out = [];
  const seen = new Set();
  for (const seg of splitRich(text, () => false)) {
    if (seg.kind !== 'link' || seen.has(seg.url)) continue;
    seen.add(seg.url);
    out.push({ url: seg.url, host: seg.host, href: seg.href });
  }
  return out;
}

/**
 * The @-search roster, in SPEC order: the chat's own people FIRST (the peer
 * you are typing to is who @ almost always means), then the other known
 * users alphabetically. Substring match on the typed query, HARD CAP 3 —
 * the popup reserves exactly three rows, so the composer never jumps.
 * Pure (no DOM): callers feed lowercase usernames.
 */
export function mentionCandidates({ query = '', currentPeer = '', peers = [], limit = 3 } = {}) {
  const q = String(query).toLowerCase();
  const seen = new Set();
  const out = [];
  const push = (u) => {
    const ul = String(u ?? '').toLowerCase();
    if (!ul || seen.has(ul)) return;
    seen.add(ul);
    if (!q || ul.includes(q)) out.push(ul);
  };
  push(currentPeer); // slot 1 always belongs to the current chat when it matches at all
  for (const p of [...peers].sort()) push(p);
  return out.slice(0, limit);
}
