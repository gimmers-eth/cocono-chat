// Single-tab guard: only one active tab per device. The first tab to answer a
// ping claims the session; any later tab shows the blocked view.
import { show } from '../ui.js';

export function startSingleTabGuard() {
  const channel = new BroadcastChannel('cocono-tab');
  let claimed = false;
  channel.onmessage = (e) => {
    if (e.data === 'ping') channel.postMessage('pong');
    if (e.data === 'pong' && !claimed) show('blocked');
  };
  channel.postMessage('ping');
  setTimeout(() => {
    claimed = true;
  }, 250);
}
