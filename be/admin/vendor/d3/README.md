# Vendored: d3-force (physics for the God View graph)

Only the force-layout modules are vendored — the God View renders its own
SVG/HTML (no d3-selection, no d3-zoom), so this is the whole dependency:

| file | package | version | size |
| --- | --- | --- | --- |
| `d3-dispatch.min.js` | d3-dispatch | 3.0.1 | 1.9 KB |
| `d3-quadtree.min.js` | d3-quadtree | 3.0.1 | 5.3 KB |
| `d3-timer.min.js` | d3-timer | 3.0.1 | 1.9 KB |
| `d3-force.min.js` | d3-force | 3.0.0 | 8.3 KB |

All four are ISC-licensed (Copyright 2010-2021 Mike Bostock), taken
unmodified from the `dist/` UMD build of each npm package
(`npm pack d3-force@3.0.0` etc.).

## Why the four files, in this order

The UMD builds do NOT bundle their dependencies — each one merges into the
global `d3` namespace and reads its deps from there, so `admin/index.html`
loads them as classic scripts **before** the module scripts:

```html
<script src="/vendor/d3/d3-dispatch.min.js"></script>
<script src="/vendor/d3/d3-quadtree.min.js"></script>
<script src="/vendor/d3/d3-timer.min.js"></script>
<script src="/vendor/d3/d3-force.min.js"></script>
```

`be/admin/godview.js` then uses `window.d3.forceSimulation` /
`forceLink` / `forceManyBody` / `forceCollide` / `forceX` / `forceY`.

Same rule as the badge artwork: one source, served from disk, never copied
into `admin/app.js`. The admin panel's CSP is `script-src 'self'` — a CDN
tag would be blocked, which is exactly why these live in the repo.

## Upgrading

Re-run `npm pack <pkg>@<version>`, copy `package/dist/<pkg>.min.js` over the
file here, and update the table above. Nothing else imports these paths.
