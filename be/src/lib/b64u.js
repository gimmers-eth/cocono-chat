export function b64uEncode(buf) {
  return Buffer.from(buf).toString('base64url');
}

// Returns a Buffer, or null when the input is not valid base64url.
export function b64uDecode(str) {
  if (typeof str !== 'string' || str.length === 0) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(str)) return null;
  return Buffer.from(str, 'base64url');
}
