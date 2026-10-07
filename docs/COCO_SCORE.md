# The CoCo Score (v1)

The **CoCo score** is a small public number shown on a user's profile that
summarises **how much of the network has vouched for them**. It is one input
to a trust decision — never the whole decision. Design goal: honest,
explainable, and hard to inflate silently.

## v1 rule

```
score  = (verifiedBy × 1) + (trustedBy × 3)
Social: Trusted  ⇔  score > COCO_TRUST_THRESHOLD (10)
                    AND trustedBy ≥ COCO_TRUST_MIN_VOUCHERS (2)
                    AND account age > COCO_TRUST_MIN_AGE_DAYS (30 days)
otherwise → Social: Untrusted
```

Everything lives in **`be/src/lib/cocoScore.js`** (weights, threshold, age
gate) — the profile, the `/api/users/:u/stats` response (`coco`,
`socialTrusted`) and every client read it from that one source, computed
server-side so nobody renders a different verdict. Threshold and age are env
config (`.env.example`). Exclusive vouch-stage buckets per
[FRIENDS.md](./FRIENDS.md):

| Voucher's stage on this profile | Weight | Why |
|---|---|---|
| Added | 0 | a contact, not a claim — costs the adder nothing |
| Verified | 1 | they compared safety numbers with the account: a real, checkable claim about the **key** |
| Trusted | 3 | they verified AND declared "this is my person" publicly — a vouch that puts their own reputation (and, per platform rules, their account) on the line |

## What it deliberately does NOT include (yet)

Roadmap signals, once their data exists and is abuse-tested:

- **Blocking / reports (planned P0 tooling)** — being blocked or reported
  should *reduce* or zero a score; a high CoCo from a colluding clique must
  not outvote many blocks. Weight: negative until it looks sane.
- **Other trust sources** — e.g. domain-based registration, invite chains,
  eventual federation or external attestations. Each new source needs its
  own anti-gaming analysis before it feeds the number.
- **Age/activity** — an account that has survived months unchanged is
  weaker bait for scammers; likely a small multiplier, not points.

## Known limits (be honest, don't oversell)

- **Collusion / Sybil**: N fake accounts can fake each other's trust. That
  is exactly why *verified* (safety-number comparison, hard to fake at
  scale) is weighted below *trusted*, and why App-level ID verification of
  the vouching side matters: future versions should only count vouches from
  **App: Verified** trusters (`verifiedBy` in the Social line is already
  the exclusive-bucket count; a v2 could split by truster verification).
- **A score is not a safety guarantee**: an attacker's *first* victims see
  a low-but-growing number. The red/green **App/Social/You** verdicts on
  the profile carry the real guidance; the score is decoration on the data.
- **Revocation**: a vouch dropped (unverify/untrust, key change, account
  deletion) immediately stops counting — the score always reflects the
  current graph, not history.

## Display rules

- Profile → Safety → Social: counts line (`Vouched by N added · N verified · N trusted`)
  then `CoCo: N — Social Score` shown in `--info` blue. No formula in the UI;
  this doc is the public explanation.
- Computed by the server; clients render it verbatim. No score is shown for
  deleted/not-found accounts, and counts never expose WHO vouched.

## Governance

- Weights and gates live in **one place**: `be/src/lib/cocoScore.js`
  (+ `COCO_TRUST_*` env config). Changing them = a version
  bump here (v2, v3…), with a short note on why — users may have written the
  number down.
- Anti-abuse of the *scoring* itself (mass self-trust attempts etc.) is part
  of the block/report P0 work; the score stays v1-experimental until then.
