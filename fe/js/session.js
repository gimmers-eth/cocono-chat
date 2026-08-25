// Session token storage. The JWT lives per-tab in sessionStorage; device
// identities live in IndexedDB (see db.js).

const KEY = 'cocono.token';

export function setToken(token) {
  if (token) sessionStorage.setItem(KEY, token);
  else sessionStorage.removeItem(KEY);
}

export const getToken = () => sessionStorage.getItem(KEY);
