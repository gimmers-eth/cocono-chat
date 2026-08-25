// Chat WebSocket client. Reconnection per DESIGN.md: exponential backoff with
// jitter, plus immediate reconnect attempts on visibilitychange / online
// events. The server initiates heartbeats (protocol pings); the browser
// answers them automatically.

export function createChatSocket({ getToken, onMessage, onState }) {
  let ws = null;
  let attempt = 0;
  let timer = null;
  let stopped = false;

  function scheduleReconnect() {
    if (timer || stopped) return;
    const base = 1000;
    const max = 30000;
    const delay = Math.min(base * 2 ** attempt, max);
    const jitter = Math.random() * 1000;
    attempt += 1;
    timer = setTimeout(() => {
      timer = null;
      connect();
    }, delay + jitter);
  }

  function connect() {
    if (stopped) return;
    const token = getToken();
    if (!token) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(token)}`);
    ws = socket;
    onState?.('connecting');
    socket.onopen = () => {
      attempt = 0;
      onState?.('open');
    };
    socket.onmessage = (e) => {
      try {
        onMessage(JSON.parse(e.data));
      } catch {
        // ignore malformed frames
      }
    };
    socket.onclose = () => {
      if (ws === socket) ws = null;
      onState?.('closed');
      if (!stopped) scheduleReconnect();
    };
    socket.onerror = () => {
      // onclose always follows
    };
  }

  function kick() {
    attempt = 0;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!ws || ws.readyState === ws.CLOSED || ws.readyState === ws.CLOSING) connect();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') kick();
  });
  window.addEventListener('online', kick);

  connect();

  return {
    send(obj) {
      if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
    },
    get state() {
      if (!ws) return 'closed';
      return ['connecting', 'open', 'closing', 'closed'][ws.readyState];
    },
    close() {
      stopped = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    },
  };
}
