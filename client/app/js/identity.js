// Safety numbers: a human-comparable rendering of a peer's account identity
// key. Two users compare these over ANY other channel (call them, read the
// digits aloud, screenshot via another app) — if they match, the key the
// server handed us is genuinely theirs, defeating a server that lies
// consistently from the first contact.
//
// Format: SHA-256 over the raw 32-byte Ed25519 key, first 16 bytes rendered
// as 8 uppercase hex groups of 4 (32 chars, easy to read aloud in chunks:
// "A3F1 92C0 ..."). Deterministic and unit-testable (works in Node: global
// crypto + atob exist since v18).

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
 * @param {string} identityKeyB64u raw Ed25519 public key, base64url
 * @returns {Promise<string>} e.g. "3AF1B2C4 D5E6... (8 groups, space separated)"
 */
export async function safetyNumber(identityKeyB64u) {
  const digest = await crypto.subtle.digest('SHA-256', b64uToBytes(identityKeyB64u));
  const head = toHex(new Uint8Array(digest).slice(0, 16));
  return (head.match(/.{4}/g) ?? []).join(' ');
}

/** Short display helper: first + last group with an ellipsis. */
export function safetyNumberShort(safe) {
  const groups = String(safe).split(' ');
  return groups.length > 2 ? `${groups[0]}…${groups.at(-1)}` : String(safe);
}
