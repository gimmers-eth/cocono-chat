export class CoconoError extends Error {
  constructor(message, code = 'client_error') {
    super(message);
    this.name = 'CoconoError';
    this.code = code;
  }
}

// Raised for every non-2xx API response; carries HTTP status + the server's
// machine-readable error code (see be/openapi.yaml).
export class CoconoApiError extends Error {
  constructor(status, code, message) {
    super(message ?? `HTTP ${status}`);
    this.name = 'CoconoApiError';
    this.status = status;
    this.code = code ?? 'unknown';
  }
}
