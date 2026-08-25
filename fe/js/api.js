export class ApiError extends Error {
  constructor(status, body) {
    super(body?.message ?? `HTTP ${status}`);
    this.status = status;
    this.code = body?.error ?? 'unknown';
  }
}

async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

async function withToken(path, token, options = {}) {
  const res = await fetch(path, { ...options, headers: { authorization: `Bearer ${token}`, ...(options.headers ?? {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

export const api = {
  signup: (body) => post('/api/signup', body),
  challenge: (body) => post('/api/auth/challenge', body),
  verify: (body) => post('/api/auth/verify', body),
  me: (token) => withToken('/api/me', token),
  enrollDevice: (body) => post('/api/devices/enroll', body),
  async enrollStatus(enrollId) {
    const res = await fetch(`/api/devices/enroll-status/${encodeURIComponent(enrollId)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, data);
    return data;
  },
  approveDevice: (token, code) =>
    withToken('/api/devices/approve', token, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    }),
  devices: (token) => withToken('/api/devices', token),
};
