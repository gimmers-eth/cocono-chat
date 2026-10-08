export const USERNAME_RE = /^[a-zA-Z0-9_-]{4,64}$/;
export const DEVICE_ID_RE = /^[a-zA-Z0-9_-]{8,64}$/;

export function isValidUsername(username) {
  return typeof username === 'string' && USERNAME_RE.test(username);
}

// Reserved NAMES are exact (case-insensitive); reserved PREFIXES block any
// name STARTING with them ('coconofan', 'co-co-no-dev'). Prefixes default to
// empty so callers/tests using the two-arg form keep working.
export function isReserved(username, reservedUsernames, reservedPrefixes = []) {
  const ul = username.toLowerCase();
  return reservedUsernames.includes(ul) || reservedPrefixes.some((p) => ul.startsWith(p));
}

export function isValidDeviceId(deviceId) {
  return typeof deviceId === 'string' && DEVICE_ID_RE.test(deviceId);
}
