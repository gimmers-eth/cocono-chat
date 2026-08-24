# fe — cocono-chat front end

The cocono-chat PWA. **Plain JavaScript only** — no frameworks and no bundler, just ES
modules served as static files by the backend (`be/`). There is nothing to build.

Current milestone scope: **accounts** — create an account (keys are generated on this
device) and log in without a password by proving possession of the device's private key.
Messaging arrives in later milestones.

For internals (crypto model, IndexedDB layout, module map), see
[README_TECH.md](./README_TECH.md).

## Running

The FE is served by the backend, so from the repo root:

```bash
pnpm install
pnpm dev
```

Then open http://127.0.0.1:3000 in a browser.

## Browser support

WebCrypto Ed25519 is required: Chrome ~113+, Safari 17+, Firefox 130+. A JS fallback
library may be added later (see DESIGN.md).

## Notes

- Your identity (private key, AES keys, device id) lives in IndexedDB on this device and
  is never uploaded. Clearing site data loses access to the account — by design, until a
  backup feature exists.
- Only one tab per device is active at a time; extra tabs show a notice.
