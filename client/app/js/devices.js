// Device naming heuristics — the browser cannot hand us a hostname (no such
// API, deliberately), so "what device is this" is derived from the
// User-Agent: both for OUR own device (guessDeviceName) and for the joining
// device the approver reviews (humanPlatform(agent)), since the enroll
// request carried the new device's own UA through to the server.
//
// Everything here is display sugar: wrong guesses are harmless and every UI
// falls back to the device id. Never used for security decisions.

const MODEL_BEFORE_BUILD = /Android[^;]*;\s*([^;)]+?)\s+Build\//;

export function humanPlatform(agent) {
  const ua = String(agent ?? '');
  if (!ua) return '';
  let os = '';
  if (/iPhone/.test(ua)) os = 'iPhone';
  else if (/iPad/.test(ua)) os = 'iPad';
  else if (/iPod/.test(ua)) os = 'iPod';
  else if (/Android/.test(ua)) os = ua.match(MODEL_BEFORE_BUILD)?.[1]?.trim() || 'Android';
  else if (/CrOS/.test(ua)) os = 'Chromebook';
  else if (/Windows/.test(ua)) os = 'Windows';
  else if (/Mac OS X|Macintosh/.test(ua)) os = 'Mac';
  else if (/Linux/.test(ua)) os = 'Linux';
  // browser: order matters — Edge/Opera/Firefox all admit 'Chrome' or
  // 'Safari' in their compatibility UA, check the distinctive token first
  let br = '';
  if (/EdgiOS|Edg\//.test(ua)) br = 'Edge';
  else if (/OPiOS|OPR\//.test(ua)) br = 'Opera';
  else if (/FxiOS|Firefox/.test(ua)) br = 'Firefox';
  else if (/CriOS|Chrome/.test(ua)) br = 'Chrome';
  else if (/Safari/.test(ua)) br = 'Safari';
  // a plain 'iPhone · Safari' reads better than 'Safari on iPhone' anywhere
  // the label is alone; join only when BOTH sides add information
  if (os && br && !os.includes(br)) return `${os} · ${br}`;
  return os || br || '';
}

// Our own device, right now.
export function guessDeviceName() {
  return humanPlatform(typeof navigator !== 'undefined' ? navigator.userAgent : '') || 'Device';
}
