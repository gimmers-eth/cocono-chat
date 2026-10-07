// Safety numbers: a PAIR-DERIVED, symmetric verification code — exactly one
// number per conversation, so BOTH users see the SAME digits and can
// compare them over any channel (call, in person, another app). Derived
// from BOTH account identity keys (founder keys frozen per account),
// ordered canonically so (mine, theirs) and (theirs, mine) hash identically:
//   SHA-256( sorted(keyA || keyB) ) -> first 16 bytes -> 8 hex groups of 4.
//
// A match proves you both hold the same pair of identities (no middleman
// per side). A mismatch means one side is being shown a different key —
// stop and investigate. Deterministic + unit-tested with fixed vectors
// (works in Node: global crypto + atob since v18). The format is user-
// visible: changing it is a UX break for anyone who wrote a number down.

const HEX = [...'0123456789ABCDEF'];

function b64uToBytes(b64u) {
  const bin = atob(b64u.replaceAll('-', '+').replaceAll('_', '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Array.from, NOT bytes.map: Uint8Array.map returns a Uint8Array again —
// the per-byte hex strings would be coerced back into numbers there.
const toHex = (bytes) =>
  Array.from(bytes, (b) => HEX[b >> 4] + HEX[b & 15]).join('');

/**
 * Symmetric pair safety number.
 * @param {string} keyA base64url Ed25519 identity key (either side)
 * @param {string} keyB base64url Ed25519 identity key (the other side)
 * @returns {Promise<string>} "XXXX XXXX ... (8 groups)" — identical when
 *   computed by both peers with their swapped inputs.
 */
export async function safetyNumber(keyA, keyB) {
  const [first, second] = String(keyA) <= String(keyB) ? [keyA, keyB] : [keyB, keyA];
  const a = b64uToBytes(first);
  const b = b64uToBytes(second);
  const joined = new Uint8Array(a.length + b.length);
  joined.set(a);
  joined.set(b, a.length);
  const digest = await crypto.subtle.digest('SHA-256', joined);
  const head = toHex(new Uint8Array(digest).slice(0, 16));
  return (head.match(/.{4}/g) ?? []).join(' ');
}

/** Short display helper: first + last group with an ellipsis. */
export function safetyNumberShort(safe) {
  const groups = String(safe).split(' ');
  return groups.length > 2 ? `${groups[0]}…${groups.at(-1)}` : String(safe);
}
