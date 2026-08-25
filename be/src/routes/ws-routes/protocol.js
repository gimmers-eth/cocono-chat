// Wire protocol constants + tiny helpers shared by the ws-routes modules.

// Hard cap on one incoming frame; oversized frames close the connection.
export const MAX_FRAME_BYTES = 64 * 1024;

// Max messages delivered/pulled in one batch.
export const PENDING_BATCH = 500;

// Redis pub/sub channel for live delivery to one device.
export const devKey = (ul, dv) => `dm:${ul}:${dv}`;

export function sendJson(socket, obj) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(obj));
}
