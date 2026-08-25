export const USERNAME_RE = /^[a-zA-Z0-9_-]{5,64}$/;
export const DEVICE_ID_RE = /^[a-zA-Z0-9_-]{8,64}$/;

export function isValidUsername(username) {
  return typeof username === 'string' && USERNAME_RE.test(username);
}

export function isReserved(username, reservedUsernames) {
  return reservedUsernames.includes(username.toLowerCase());
}

export function isValidDeviceId(deviceId) {
  return typeof deviceId === 'string' && DEVICE_ID_RE.test(deviceId);
}
