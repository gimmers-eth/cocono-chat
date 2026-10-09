// WebSocket layer (milestone 3): JWT-authenticated per-device connections,
// server-initiated heartbeats, Redis pub/sub fan-out across nodes, and
// store-and-forward delivery.
//
// Wire protocol (JSON frames):
//   client -> server: { type: 'msg', msg: envelope }
//                     { type: 'pulled', ids: [mid, ...] }
//                     { type: 'resync' }   re-deliver own pulled copies
//                                          (still inside the retention window)
//                     { type: 'presence', online: bool }
//                          attention opt-out: blurred/hidden client releases
//                          its presence key so push (OS notification) takes
//                          over immediately instead of after the TTL
//   server -> client: { type: 'hello' }
//                     { type: 'msg', id, ts, env }
//                     { type: 'ack', cid, ok, error? }
//                     { type: 'delivered', cid, to }
//                     { type: 'notice', what }  server nudge: re-pull the
//                          named slice of YOUR authoritative data (content-
//                          free by design — the taxonomy and the whole
//                          pattern live in lib/notify.js)
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
import { presenceKey, pushSentPattern } from '../../lib/push.js';
import { createHandlers } from './handlers.js';

export default async function wsRoutes(app, { users, redis, config, messages, settings, counters }) {
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
      // Refresh presence unless this client opted out (blurred/hidden):
      // a dead node's keys still expire via TTL = push territory.
      if (!socket.presenceOff) {
        const [ul, dv] = key.split(':');
        redis.set(presenceKey(ul, dv), '1', { EX: config.wsHeartbeatSec + 10 }).catch(() => {});
      }
    }
  }, config.wsHeartbeatSec * 1000);
  heartbeat.unref?.();

  app.addHook('onClose', async () => {
    clearInterval(heartbeat);
    await Promise.allSettled([pub.quit(), sub.quit()]);
  });

  const { handleSend, handlePulled, handleResync, deliverPending } = createHandlers({
    users,
    redis,
    pub,
    config,
    messages,
    settings, counters,
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
    await redis.set(presenceKey(ul, dv), '1', { EX: config.wsHeartbeatSec + 10 });
    // The device is back: any queued backlog is being delivered over this
    // socket RIGHT NOW, so every 'recently pushed' gate for it is spent —
    // drop them so the NEXT offline message notifies immediately instead of
    // silently landing inside a stale coalescing window.
    try {
      const gates = await redis.keys(pushSentPattern(ul, dv));
      if (gates?.length) await redis.del(gates);
    } catch { /* best-effort: keys also expire on their own */ }
    socket.on('pong', () => {
      socket.isAlive = true;
    });

    // THE RACE FIX: a client may answer 'hello' faster than this handler
    // finishes its async setup (deliverPending's Mongo query). Events with no
    // listener are DROPPED by the emitter, so attach a queueing listener
    // BEFORE hello and hand over to the real dispatch once setup is done.
    const early = [];
    const queueEarly = (raw) => { early.push(raw); };
    socket.on('message', queueEarly);

    sendJson(socket, { type: 'hello' });
    try {
      await deliverPending(socket, ul, dv);
    } catch (err) {
      app.log.error(err);
    }

    socket.off('message', queueEarly);
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
        else if (body?.type === 'resync') await handleResync(socket, ul, dv);
        else if (body?.type === 'presence') {
          // Client honesty about attention: focused app = suppress push,
          // blurred/hidden = release presence NOW so background messages
          // go straight to the OS via push (instead of waiting for the
          // presence TTL or a dead socket to be noticed).
          const online = body.online === true;
          socket.presenceOff = !online;
          if (online) await redis.set(presenceKey(ul, dv), '1', { EX: config.wsHeartbeatSec + 10 });
          else await redis.del(presenceKey(ul, dv));
        }
      } catch (err) {
        app.log.error(err);
        sendJson(socket, { type: 'error', error: 'internal' });
      }
    });

    // Drain anything that queued during setup, in arrival order.
    for (const raw of early.splice(0)) socket.emit('message', raw);

    socket.on('close', () => {
      if (local.get(key) === socket) {
        local.delete(key);
        // Only clear if this socket is still the one that owns the presence
        // key (a reconnect may already have replaced it).
        redis.del(presenceKey(ul, dv)).catch(() => {});
      }
    });
  });
}
