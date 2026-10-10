import { fail } from '../shared.js';
import { cocoScore } from '../../lib/cocoScore.js';
import { badgeScore, badgesFor, visibleDisplayBadge } from '../../lib/badges.js';
import { normUl } from '../../lib/shares.js';
import { cocoPenalty, timeoutActive } from '../../lib/moderation.js';

// ---- GOD VIEW: the whole social graph, computed on demand ---------------
// Three edge kinds, all derived from data the server already holds:
//
//   created  A's share link created B        (users.ref + shares.created)
//   seen     B opened A's link with an
//            account that already existed    (shares pair docs)
//   msg      A has messaged B                (contacts pair docs)
//
// Nodes are every live account (plus "ghost" nodes for deleted parents that
// a live account's `ref` still names — the origin story outlives the
// originator).
//
// The snapshot is STORED (collection `graph`, one doc `_id:'godview'`) and
// only recomputed when the admin asks: a full rebuild reads every user, so
// it is an explicit act, not something a page load should trigger. The
// client's laid-out positions are saved back into the same doc, so reopening
// the page shows the identical picture instantly (no re-simulation).
//
// Nothing here reads message CONTENT — the envelope is E2EE and the graph
// only ever needs the addressing metadata the server already saw.

const GRAPH_ID = 'godview';

/**
 * Vouch buckets for every account in ONE pass (the naive per-user
 * countDocuments version is what the public stats route does for a single
 * profile; here it would be 3N queries). Mirrors routes/app-routes/
 * userStats.js exactly, including the rule that only ID-VERIFIED vouchers
 * count toward verifiedBy/trustedBy.
 */
function vouchBuckets(docs) {
  const byUl = new Map(docs.map((d) => [d.ul, { addedBy: 0, verifiedBy: 0, trustedBy: 0 }]));
  for (const doc of docs) {
    // EFFECTIVE verified: a staff-timed-out voucher's word counts for
    // nothing while its timeout runs (lib/moderation.js, mirrors
    // routes/app-routes/userStats.js)
    const voucherCounts = doc.verified === true && !timeoutActive(doc);
    for (const f of doc.friends ?? []) {
      const entry = typeof f === 'string' ? { u: f } : f;
      const target = byUl.get(normUl(entry?.u));
      if (!target) continue; // friend entry for a deleted/unknown name
      const trusted = entry.t === true;
      const verified = entry.v === true;
      if (!verified && !trusted) target.addedBy += 1;
      if (voucherCounts && verified && !trusted) target.verifiedBy += 1;
      if (voucherCounts && trusted) target.trustedBy += 1;
    }
  }
  return byUl;
}

/**
 * Generation depth + descendant count over the CREATED forest (roots =
 * accounts with no parent). Both are cheap BFS/DFS over ≤ N edges and give
 * the God View something to size and colour nodes by. Cycle-safe: a client
 * could claim any referrer it likes, so never trust the shape to be a tree.
 */
function createdTree(nodes, createdEdges) {
  const children = new Map();
  for (const e of createdEdges) {
    if (!children.has(e.s)) children.set(e.s, []);
    children.get(e.s).push(e.t);
  }
  const byUl = new Map(nodes.map((n) => [n.ul, n]));
  for (const n of nodes) { n.gen = null; n.tree = 0; }

  const roots = nodes.filter((n) => !n.ref).map((n) => n.ul);
  // depth: shortest chain from any root (BFS)
  const queue = roots.map((ul) => ({ ul, d: 0 }));
  const seenDepth = new Set();
  while (queue.length) {
    const { ul, d } = queue.shift();
    const node = byUl.get(ul);
    if (!node || seenDepth.has(ul)) continue;
    seenDepth.add(ul);
    node.gen = d;
    for (const c of children.get(ul) ?? []) queue.push({ ul: c, d: d + 1 });
  }
  // descendants: iterative post-order over the same forest, memoised, with a
  // recursion guard so a claimed cycle cannot hang the request
  const memo = new Map();
  const count = (ul, stack) => {
    if (memo.has(ul)) return memo.get(ul);
    if (stack.has(ul)) return 0; // cycle: count nothing further down
    stack.add(ul);
    let total = 0;
    for (const c of children.get(ul) ?? []) total += 1 + count(c, stack);
    stack.delete(ul);
    memo.set(ul, total);
    return total;
  };
  for (const n of nodes) {
    n.tree = count(n.ul, new Set());
    if (n.gen === null) n.gen = -1; // unreachable from any root (claimed cycle)
  }
}

/** Recompute the whole snapshot from live collections. */
export async function buildGraphSnapshot({ users, shares, contacts, profiles, config }) {
  const docs = await users.find({}, {
    projection: {
      u: 1, ul: 1, verified: 1, premium: 1, displayBadge: 1, awards: 1,
      createdAt: 1, ref: 1, friends: 1, 'devices.id': 1,
      // staff moderation (lib/moderation.js): the graph shows the danger
      // mark and scores the CoCo penalty exactly like the live routes
      timeoutUntil: 1, banned: 1,
    },
  }).sort({ createdAt: 1 }).toArray();
  const avatarUls = new Set(
    (await profiles.find({ avatar: { $ne: null } }, { projection: { ul: 1 } }).toArray()).map((p) => p.ul),
  );
  const buckets = vouchBuckets(docs);

  const nodes = docs.map((doc) => {
    const held = badgesFor(doc);
    const b = buckets.get(doc.ul) ?? { addedBy: 0, verifiedBy: 0, trustedBy: 0 };
    const { score, trusted } = cocoScore(
      { verifiedBy: b.verifiedBy, trustedBy: b.trustedBy, badgePoints: badgeScore(held, config), penalty: cocoPenalty(doc, config) },
      doc.createdAt ?? new Date(0),
    );
    return {
      ul: doc.ul,
      u: doc.u ?? doc.ul,
      verified: doc.verified === true && !timeoutActive(doc),
      malicious: timeoutActive(doc),
      banned: doc.banned === true,
      premium: doc.premium === true,
      badge: visibleDisplayBadge(doc),
      badges: held.map((x) => x.id),
      coco: score,
      trusted,
      addedBy: b.addedBy,
      verifiedBy: b.verifiedBy,
      trustedBy: b.trustedBy,
      createdAt: doc.createdAt ?? null,
      devices: (doc.devices ?? []).length,
      hasAvatar: avatarUls.has(doc.ul),
      ref: doc.ref?.by ? normUl(doc.ref.by) : null,
      refAt: doc.ref?.at ?? null,
      gone: false,
    };
  });
  const live = new Set(nodes.map((n) => n.ul));

  // ---- edges -----------------------------------------------------------
  const created = [];
  const seen = [];
  const msgs = [];
  const pairSeen = new Set(); // `${s}->${t}` for created (two sources agree)

  // created, source 1: each account's own origin record (authoritative, and
  // the ONLY surviving evidence once the referrer is deleted)
  for (const n of nodes) {
    if (!n.ref || n.ref === n.ul) continue;
    pairSeen.add(`${n.ref}->${n.ul}`);
    created.push({ s: n.ref, t: n.ul, k: 'created', n: 1, at: n.refAt ?? n.createdAt });
  }
  // created, source 2: the owner side written at the same signup (carries
  // click counts for pairs whose child is gone-but-recorded)
  if (shares) {
    for await (const row of shares.find({}, { projection: { _id: 0 } }).stream()) {
      const o = normUl(row.o);
      const v = normUl(row.viewer);
      if (!o || !v) continue;
      if (row.created) {
        if (pairSeen.has(`${o}->${v}`)) continue;
        pairSeen.add(`${o}->${v}`);
        created.push({ s: o, t: v, k: 'created', n: 1, at: row.created });
      } else {
        seen.push({ s: o, t: v, k: 'seen', n: row.n ?? 1, at: row.lastAt ?? row.firstAt ?? null });
      }
    }
  }
  if (contacts) {
    for await (const row of contacts.find({}, { projection: { _id: 0 } }).stream()) {
      const f = normUl(row.from);
      const t = normUl(row.to);
      if (!f || !t || f === t) continue;
      msgs.push({ s: f, t: t, k: 'msg', n: row.n ?? 1, at: row.lastAt ?? row.firstAt ?? null });
    }
  }

  // ghost nodes: an edge endpoint that no longer exists (a deleted parent a
  // live account still names). Ghosts never appear for msg/seen edges —
  // those rows are purged with the account.
  for (const e of created) {
    for (const ul of [e.s, e.t]) {
      if (live.has(ul)) continue;
      live.add(ul);
      nodes.push({
        ul, u: ul, verified: false, premium: false, badge: null, badges: [],
        coco: 0, trusted: false, addedBy: 0, verifiedBy: 0, trustedBy: 0,
        createdAt: null, devices: 0, hasAvatar: false, ref: null, refAt: null,
        gone: true,
      });
    }
  }

  createdTree(nodes, created);

  // per-node degree counters (labels + sizing in the UI)
  const deg = new Map(nodes.map((n) => [n.ul, { created: 0, seen: 0, out: 0, in: 0 }]));
  const bump = (ul, key, by = 1) => {
    const d = deg.get(ul);
    if (d) d[key] += by;
  };
  for (const e of created) bump(e.s, 'created'); // accounts THIS node brought in
  for (const e of seen) { bump(e.s, 'seen'); }   // existing accounts that opened its link
  for (const e of msgs) { bump(e.s, 'out'); bump(e.t, 'in'); }
  for (const n of nodes) {
    const d = deg.get(n.ul) ?? { created: 0, seen: 0, out: 0, in: 0 };
    n.invited = d.created;   // accounts this one brought in
    n.viewers = d.seen;      // existing accounts that opened its link
    n.sentTo = d.out;        // distinct people it has messaged
    n.heardFrom = d.in;      // distinct people that messaged it
  }

  const edges = [...created, ...seen, ...msgs];
  return {
    generatedAt: new Date(),
    stats: {
      users: docs.length,
      ghosts: nodes.filter((n) => n.gone).length,
      nodes: nodes.length,
      edges: edges.length,
      created: created.length,
      seen: seen.length,
      msg: msgs.length,
      deepest: nodes.reduce((m, n) => Math.max(m, n.gen ?? 0), 0),
    },
    nodes,
    edges,
  };
}

export default async function graphRoutes(app, { users, shares, contacts, profiles, config, graph }) {
  const store = graph; // collection `graph`, single doc _id:'godview'

  // GET /api/admin/graph — the STORED snapshot (never recomputes). The panel
  // shows "never generated" when there is none; a stale snapshot is a fact
  // the UI states with its timestamp, not something it silently refreshes.
  app.get('/api/admin/graph', async () => {
    if (!store) return { snapshot: null };
    const doc = await store.findOne({ _id: GRAPH_ID });
    if (!doc) return { snapshot: null };
    return {
      snapshot: {
        generatedAt: doc.generatedAt ?? null,
        layoutSavedAt: doc.layoutSavedAt ?? null,
        stats: doc.stats ?? {},
        nodes: doc.nodes ?? [],
        edges: doc.edges ?? [],
        layout: doc.layout ?? null,
      },
    };
  });

  // POST /api/admin/graph — regenerate on demand. The previous layout is
  // dropped: it described the previous node set, and reusing it would pin
  // newcomers on top of whoever used to stand there. Pass { keepLayout:true }
  // to keep positions for nodes that survived (a re-generation after a small
  // change then looks like the same map, plus the new arrivals).
  app.post('/api/admin/graph', async (request) => {
    const snapshot = await buildGraphSnapshot({ users, shares, contacts, profiles, config });
    const prev = store ? await store.findOne({ _id: GRAPH_ID }, { projection: { layout: 1 } }) : null;
    const keep = request.body?.keepLayout === true && prev?.layout ? prev.layout : null;
    const layout = keep
      ? Object.fromEntries(Object.entries(keep).filter(([ul]) => snapshot.nodes.some((n) => n.ul === ul)))
      : null;
    if (store) {
      await store.updateOne(
        { _id: GRAPH_ID },
        {
          $set: {
            generatedAt: snapshot.generatedAt,
            stats: snapshot.stats,
            nodes: snapshot.nodes,
            edges: snapshot.edges,
            ...(layout ? { layout, layoutSavedAt: prev?.layoutSavedAt ?? null } : {}),
          },
          ...(!layout ? { $unset: { layout: '', layoutSavedAt: '' } } : {}),
        },
        { upsert: true },
      );
    }
    return { snapshot: { ...snapshot, layout } };
  });

  // PUT /api/admin/graph/layout — save the client's laid-out positions into
  // the stored snapshot so the next open renders the SAME picture without
  // re-running the simulation. Body: { positions: { <ul>: [x, y] } }.
  app.put('/api/admin/graph/layout', async (request, reply) => {
    if (!store) return fail(reply, 'unavailable', 'Graph store not available', 503);
    const doc = await store.findOne({ _id: GRAPH_ID }, { projection: { nodes: 1 } });
    if (!doc) return fail(reply, 'no_graph', 'Generate the graph first', 404);
    const positions = request.body?.positions;
    if (positions === null) {
      await store.updateOne({ _id: GRAPH_ID }, { $unset: { layout: '', layoutSavedAt: '' } });
      return { saved: 0, cleared: true };
    }
    if (!positions || typeof positions !== 'object' || Array.isArray(positions)) {
      return fail(reply, 'invalid_request', 'positions must be an object of ul -> [x, y]', 400);
    }
    const known = new Set((doc.nodes ?? []).map((n) => n.ul));
    const layout = {};
    for (const [ul, xy] of Object.entries(positions)) {
      if (!known.has(ul)) continue;               // stale node from an older snapshot
      if (!Array.isArray(xy) || xy.length !== 2) continue;
      const [x, y] = xy;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      layout[ul] = [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
    }
    await store.updateOne(
      { _id: GRAPH_ID },
      { $set: { layout, layoutSavedAt: new Date() } },
      { upsert: true },
    );
    return { saved: Object.keys(layout).length, layoutSavedAt: new Date() };
  });
}
