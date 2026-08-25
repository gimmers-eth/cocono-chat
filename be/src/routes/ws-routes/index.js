// WebSocket layer (milestone 3): JWT-authenticated per-device connections,
// server-initiated heartbeats, Redis pub/sub fan-out across nodes, and
// store-and-forward delivery.
//
// Wire protocol (JSON frames):
//   client -> server: { type: 'msg', msg: envelope }
//                     { type: 'pulled', ids: [mid, ...] }
//   server -> client: { type: 'hello' }
//                     { type: 'msg', id, ts, env }
//                     { type: 'ack', cid, ok, error? }
//                     { type: 'delivered', cid, to }
//
// Envelope: { m: { d, u, dv, f, fd, cid, t, h }, s? }
//   d   E2EE ciphertext (AES-GCM, b64u iv||ct) for the destination device
//   u   recipient username        dv  recipient device id
//   f   sender username           fd  sender device id
//   cid client message id (idempotent retries)
//   t   client epoch seconds (freshness window)
//   h   HMAC-SHA256 over canonical(m minus h), keyed with the sender's
//       transport AES key (server-verifiable integrity + sender auth)
//   s   optional Ed25519 signature over canonical(m)
//
// Split across this folder:
//   protocol.js  wire constants + sendJson/devKey helpers
//   envelope.js  envelope validation (structure/freshness/HMAC/signature)
//   handlers.js  handleSend / handlePulled / deliverPending
//   index.js     this file — plugin wiring, heartbeats, auth, dispatch
import { createClient } from 'redis';
import fastifyWebsocket from '@fastify/websocket';
import { verifyJwt } from '../../lib/jwt.js';
import { MAX_FRAME_BYTES, sendJson } from './protocol.js';
import { createHandlers } from './handlers.js';

export default async function wsRoutes(app, { users, redis, config, messages }) {
  await app.register(fastifyWebsocket);

  // Dedicated pub/sub clients: a redis client in subscribe mode cannot run
  // regular commands.
  const pub = createClient({ url: config.redisUrl });
  const sub = createClient({ url: config.redisUrl });
  await Promise.all([pub.connect(), sub.connect()]);

  const local = new Map(); // `${ul}:${dv}` -> socket

  // Cross-node fan-out: every node hears all device channels and forwards to
  // the socket connected locally, if any.
  await sub.pSubscribe('dm:*', (message, channel) => {
    const socket = local.get(channel.slice(3)); // strip 'dm:'
    if (socket && socket.readyState === socket.OPEN) socket.send(message);
  });

  // Server-initiated heartbeat (DESIGN): ping every cycle, terminate
  // connections that missed the previous pong.
  const heartbeat = setInterval(() => {
    for (const [key, socket] of local) {
      if (!socket.isAlive) {
        local.delete(key);
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
  }, config.wsHeartbeatSec * 1000);
  heartbeat.unref?.();

  app.addHook('onClose', async () => {
    clearInterval(heartbeat);
    await Promise.allSettled([pub.quit(), sub.quit()]);
  });

  const { handleSend, handlePulled, deliverPending } = createHandlers({
    users,
    redis,
    pub,
    config,
    messages,
  });

  app.get('/ws', { websocket: true }, async (socket, request) => {
    // Auth: JWT in the query string (browsers cannot set WS upgrade
    // headers). The token is redacted from request logs in app.js.
    const token = request.query.token;
    const payload = typeof token === 'string' ? verifyJwt(token, config.jwtSecret) : null;
    if (!payload) return socket.close(4401, 'unauthorized');
    const user = await users.findOne({ ul: payload.sub }, { projection: { 'devices.id': 1 } });
    if (!user?.devices.some((dev) => dev.id === payload.d)) {
      return socket.close(4401, 'unauthorized');
    }

    const ul = payload.sub;
    const dv = payload.d;
    const key = `${ul}:${dv}`;

    // One live connection per device — newest wins.
    const prev = local.get(key);
    if (prev && prev !== socket) prev.close(4000, 'replaced');
    local.set(key, socket);
    socket.isAlive = true;
    socket.on('pong', () => {
      socket.isAlive = true;
    });

    sendJson(socket, { type: 'hello' });
    await deliverPending(socket, ul, dv);

    socket.on('message', async (raw) => {
      if (raw.length > MAX_FRAME_BYTES) return socket.close(4413, 'frame too large');
      let body;
      try {
        body = JSON.parse(raw.toString());
      } catch {
        return;
      }
      try {
        if (body?.type === 'msg') await handleSend(socket, request, body, payload);
        else if (body?.type === 'pulled') await handlePulled(socket, body, payload);
      } catch (err) {
        app.log.error(err);
        sendJson(socket, { type: 'error', error: 'internal' });
      }
    });

    socket.on('close', () => {
      if (local.get(key) === socket) local.delete(key);
    });
  });
}
