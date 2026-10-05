// Single-tab guard: only one active tab per device (first tab wins; the
// second sees the blocked view).

import { showView } from '../ui.js';

export function startSingleTabGuard() {
  const channel = new BroadcastChannel('cocono-tab');
  let claimed = false;
  channel.onmessage = (e) => {
    if (e.data === 'ping') channel.postMessage('pong');
    else if (e.data === 'pong' && !claimed) showView('blocked');
  };
  channel.postMessage('ping');
  setTimeout(() => {
    claimed = true;
  }, 250);
}
