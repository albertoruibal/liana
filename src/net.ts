// Node-only outbound-HTTP tuning, applied once at backend startup by the two
// adapters that host the API (dev.ts, electron/server.ts). Never imported by the
// browser bundle.
//
// Node's built-in fetch enforces undici's own response timeouts, independent of
// our per-request AbortController: response headers must arrive within 300s or
// the request dies with `UND_ERR_HEADERS_TIMEOUT`, and a streaming body must not
// stall past 300s or it dies with `UND_ERR_BODY_TIMEOUT`. A slow local model
// routinely exceeds that before it emits its first token, so raise those two
// ceilings and let our AbortController (12h for AI, 30s for forges) be the single
// deadline. Connect stays at undici's 10s default so an unreachable host still
// fails fast with a clear cause.

import { Agent, setGlobalDispatcher } from 'undici';

/** Ceiling for receiving response headers / streaming body chunks (30 min). */
const RESPONSE_TIMEOUT_MS = 30 * 60 * 1000;

let configured = false;

/** Idempotently relax undici's response timeouts for the process's global fetch. */
export function configureNetwork(): void {
  if (configured) return;
  configured = true;
  setGlobalDispatcher(
    new Agent({ headersTimeout: RESPONSE_TIMEOUT_MS, bodyTimeout: RESPONSE_TIMEOUT_MS }),
  );
}
