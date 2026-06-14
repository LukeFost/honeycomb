// ============================================================================
// honeycomb-api client config (server-side only).
//
// The /ops dashboard talks to the deployed honeycomb-api over HTTP. Two surfaces:
//
//   READ  (/jobs, /events, /reputation, /skill) -- no auth, safe anywhere.
//   WRITE (/grade, /bounties, /submit, /snapshot) -- token-guarded; the token is
//         injected SERVER-SIDE by /api/honeycomb and NEVER sent to the browser.
//
// "dev mode" is the single switch that decides whether the write surface is
// exposed at all. It is true only when HONEYCOMB_DEV=1 (set in the local
// .env.local, never in the Cloud Run deploy). So:
//
//   deployed  -> HONEYCOMB_DEV unset      -> /ops is read-only, no token in scope,
//                no perms to manage. Public-safe by construction.
//   local dev -> HONEYCOMB_DEV=1 + token  -> /ops gains grade/create controls,
//                token read from env (which the operator seeds from the keychain).
//
// Nothing here is exported to the client bundle: import this only from server
// components and /api route handlers.
// ============================================================================

/** The deployed honeycomb-api base URL. Override with HONEYCOMB_API_URL. */
export const HONEYCOMB_API_URL = (
  process.env.HONEYCOMB_API_URL ??
  "https://honeycomb-api-912224428574.us-central1.run.app"
).replace(/\/+$/, "");

/** Write surface is exposed only in local dev (HONEYCOMB_DEV=1). */
export function isDevMode(): boolean {
  return process.env.HONEYCOMB_DEV === "1";
}

/** The write-route token (local dev only). Null when absent so callers can 503. */
export function writeToken(): string | null {
  const t = process.env.HONEYCOMB_API_TOKEN;
  return t && t.length > 0 ? t : null;
}

/** GET a read route on honeycomb-api and parse JSON. Throws loudly on non-2xx. */
export async function apiGet<T = unknown>(path: string): Promise<T> {
  const url = `${HONEYCOMB_API_URL}${path.startsWith("/") ? path : `/${path}`}`;
  const res = await fetch(url, { cache: "no-store" });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`honeycomb-api ${res.status} on GET ${path}: ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`honeycomb-api returned non-JSON on GET ${path}: ${text.slice(0, 200)}`);
  }
}
