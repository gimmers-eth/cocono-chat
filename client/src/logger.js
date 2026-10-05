// Console logging, gated by the `logging` client option.
//   logging: false        — silent (default)
//   logging: true         — console output tagged [cocono-sdk]
//   logging: fn           — custom sink (level, ...args) => void

export const LOG_PREFIX = '[cocono-sdk]';

export function createLogger(logging = false) {
  const sink =
    typeof logging === 'function'
      ? logging
      : logging
        ? (level, ...args) => console.log(`${LOG_PREFIX} ${level}`, ...args)
        : () => {};
  return {
    debug: (...a) => sink('debug', ...a),
    info: (...a) => sink('info', ...a),
    warn: (...a) => sink('warn', ...a),
    error: (...a) => sink('error', ...a),
    enabled: Boolean(logging),
  };
}
