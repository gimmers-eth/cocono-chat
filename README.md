# cocono-chat

A web-based messaging app built with Node.js and WebSockets. The app is a PWA designed to
run on any system.

Messages are end-to-end encrypted: every conversation has its own AES key (WhatsApp-style),
accounts have no passwords — ownership is proven with Ed25519 keys that never leave the
device. See [DESIGN.md](./DESIGN.md) for the full design (resolved via
[QUESTIONS.md](./QUESTIONS.md) / [ANSWERS.md](./ANSWERS.md)).

## Status

MVP milestones, in order:

1. **Accounts** — done
2. Multi-device — next
3. 1:1 messages (text)
4. Files/media (images etc.)
5. Groups (with offline delivery)
6. PWA polish (push, offline)
7. Subgroups / tags

## Repository layout

pnpm monorepo:

| Path | Description | Docs |
| ---- | ----------- | ---- |
| `be/` | Node.js backend — Fastify REST API, MongoDB, Redis; serves the FE as static files | [README](./be/README.md) · [Technical](./be/README_TECH.md) · [OpenAPI](./be/openapi.yaml) |
| `fe/` | Legacy PWA (kept for reference; no longer served) | [README](./fe/README.md) · [Technical](./fe/README_TECH.md) |
| `client/` | `@cocono/client` — event-driven JS SDK (register, login, pairing, E2EE messaging) **+ the new themeable FE** in `client/app` (WhatsApp-style, responsive, served at `/` with the SDK mounted at `/sdk/`) | [README](./client/README.md) · [SDK docs](./docs/CLIENT_SDK.md) · [Themes](./client/app/themes/README.md) |

## Quickstart

Prerequisites:

- Node.js ≥ 22.9 (developed on Node 24)
- pnpm (`corepack enable` or `npm i -g pnpm`)
- Redis running locally on `redis://127.0.0.1:6379` (any recent version)
- No MongoDB install needed — dev mode runs a persistent
  [mongodb-memory-server](https://github.com/nodkz/mongodb-memory-server) automatically

Then:

```bash
pnpm install
pnpm dev          # starts MongoDB (dev) + the server on http://127.0.0.1:3000
```

Open http://127.0.0.1:3000 and create an account.

Run the tests (unit + integration, needs local Redis):

```bash
pnpm test           # backend
pnpm test:client    # client SDK (boots the real backend in-process)
pnpm test:all       # both
```

## Configuration

Everything is configured via environment variables — see
[be/.env.example](./be/.env.example) for the full list (ports, Mongo/Redis URLs, JWT
secret, rate limits, reserved usernames). `pnpm dev` works without a `.env`; copy the
example and adjust when needed.

## Documentation

- [DESIGN.md](./DESIGN.md) — architecture, encryption model, delivery, milestones
- [docs/CLIENT_SDK.md](./docs/CLIENT_SDK.md) — client SDK: usage, events, pairing, storage, logging
- [client/app/themes/README.md](./client/app/themes/README.md) — bootstrapping FE themes
- [docs/SIGNUP.md](./docs/SIGNUP.md) — signup, passwordless login and multi-device pairing (with API examples)
- [docs/MESSAGES.md](./docs/MESSAGES.md) — message sending & delivery: online, offline, multi-device (with protocol examples)
- [QUESTIONS.md](./QUESTIONS.md) / [ANSWERS.md](./ANSWERS.md) — design decisions log
- [be/openapi.yaml](./be/openapi.yaml) — REST API specification
