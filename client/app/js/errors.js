// Human-readable error copy — the single place server/SDK error codes are
// translated for the UI (toasts, statuses). Keep strings SHORT. Unknown
// codes fall back to the message (when readable) or a generic line, but add
// a row here whenever a new code ships: that keeps UI copy reviewable.
//
// Codes sourced from: ws acks (handlers.js/envelope.js), REST fail(...)
// codes (routes), and SDK CoconoError/CoconoApiError codes.

export const ERROR_TEXT = {
  // --- send / transport ---
  invalid_envelope: 'Message was malformed — not sent.',
  sender_mismatch: 'Device identity mismatch — not sent.',
  bad_hmac: 'Message seal failed — not sent.',
  bad_sender_key: 'Unknown sender key — not sent.',
  bad_recipient_key: 'Unknown recipient key — not sent.',
  unknown_device: 'This device is no longer on the account.',
  unknown_recipient: 'That user no longer exists.',
  verify_required: 'You need to get verified before messaging new people.',
  rate_limited: 'Too many messages — wait a moment.',
  not_connected: 'Not connected right now.',
  no_peer_devices: 'That user has no devices to receive.',
  internal: 'Server hiccup — try again.',

  // --- accounts / auth ---
  invalid_username: 'Names need 4–64 letters, numbers, - or _.',
  bad_username: 'Names need 4–64 letters, numbers, - or _.',
  reserved_username: 'That name is reserved.',
  username_taken: 'Name already taken.',
  unknown_account: 'No such user.',
  invalid_signature: 'This device couldn’t prove it owns that account.',
  bad_signature: 'This device couldn’t prove it owns that account.',
  invalid_device_id: 'Bad device id.',
  device_exists: 'That device is already on the account.',
  device_limit: 'Too many devices on this account.',
  stale_payload: 'That request expired — try again.',
  replay: 'That request was already used.',
  bad_nonce: 'Login step expired — try again.',
  expired: 'That link expired — try again.',
  session_expired: 'Session expired — log in again.',
  not_authenticated: 'Log in again.',
  unauthorized: 'Log in again.',
  identity_exists: 'This browser already has an account.',
  no_identity: 'No saved account here — sign in first.',
  not_supported: 'Not supported by this device.',

  // --- pairing ---
  unknown_code: 'Pairing code not recognised.',
  enroll_busy: 'Another pairing is in progress.',
  pairing_cancelled: 'Pairing cancelled.',
  pairing_expired: 'Pairing code expired — start again.',

  // --- friends / trust ladder ---
  self_friend: 'You can’t add yourself.',
  friends_full: 'Friends list is full.',
  not_friends: 'Add them first.',
  stage_required: 'Verify the safety number first.',
  not_mutual: 'They must add you back first — verification needs a mutual add.',

  // --- identity verification / ID photo ---
  already_verified: 'Already verified.',
  needs_trusted_verifier: 'ID upload unlocks once a verified user trusts you — ask a friend to trust you.',
  bad_content_type: 'Photo must be a PNG or JPEG.',
  not_an_image: 'That file isn’t a real photo.',
  too_large: 'Photo too large.',
  too_small: 'Photo looks empty — retake it.',
  invalid_request: 'That didn’t look right.',
};

/** Short human line for a bare error code (acks carry codes, not Errors). */
export function errorText(code, fallback) {
  return ERROR_TEXT[code] ?? (fallback ? (typeof fallback === 'function' ? fallback() : fallback)
    : (code ? `Something went wrong (${code}).` : 'Something went wrong.'));
}

/** Short human line from a caught Error (CoconoError / CoconoApiError / DOM). */
export function humanError(err, fallback = 'Something went wrong.') {
  if (!err) return fallback;
  const mapped = ERROR_TEXT[err.code];
  if (mapped) return mapped;
  const msg = typeof err.message === 'string' ? err.message.trim() : '';
  // server messages are already sentences; raw codes / "HTTP 4xx" are not
  if (msg && !ERROR_TEXT[msg] && !/^HTTP \d{3}$/.test(msg) && !/^[a-z_]+$/.test(msg)) {
    return msg.length > 90 ? `${msg.slice(0, 87)}…` : msg;
  }
  return fallback;
}
