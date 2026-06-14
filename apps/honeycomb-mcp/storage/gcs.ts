// ============================================================================
// gcs.ts — content-addressed blob transport for the bounty content layer.
//
// This is the off-chain store that the on-chain `specCid` / `encCid` pointers
// resolve into. Specs and sealed submissions are uploaded here; the CID is just
// a `gcs://<bucket>/<sha256hex>` URI, where the key IS the sha256 of the bytes —
// so the CID doubles as an integrity check (fetch, re-hash, compare).
//
// Two buckets (created in Phase 0, private + uniform-access):
//   gs://honeycomb-specs        — public-spec markdown (readable by any agent w/ auth)
//   gs://honeycomb-submissions  — sealed-box ciphertexts (only the enclave can decrypt)
//
// Auth mirrors apps/web/src/app/api/summon/route.ts: google-auth-library is
// Node-only and works on BOTH Cloud Run (metadata server) and locally (ADC /
// the active gcloud SA), so we lazily import it and ask for an access token.
// No key files, no new auth surface. A failed token mint or non-2xx THROWS —
// per the repo's loud-failure rule, we never silently return empty content.
// ============================================================================

import { createHash } from "node:crypto";

export const SPECS_BUCKET = process.env.HONEYCOMB_SPECS_BUCKET ?? "honeycomb-specs";
export const SUBMISSIONS_BUCKET =
	process.env.HONEYCOMB_SUBMISSIONS_BUCKET ?? "honeycomb-submissions";

// GCS read/write needs this OAuth scope; the SA already holds objectAdmin/Viewer.
const GCS_SCOPE = "https://www.googleapis.com/auth/devstorage.read_write";

// Cache the access token across calls in a process. google-auth-library hands
// back a token with an expiry; getAccessToken() refreshes it internally, so we
// just keep one auth client. Lazily constructed so importing this module never
// reaches the network (matches the summon route's lazy import).
let _authPromise: Promise<{ getAccessToken: () => Promise<string | null | undefined> }> | null = null;

async function accessToken(): Promise<string> {
	// Explicit override: a pre-minted OAuth access token. Cloud Run never needs
	// this (the metadata server provides the runtime SA via ADC), but it lets a
	// local/CI run drive GCS as a specific SA without the ADC well-known file —
	// e.g. `GCS_ACCESS_TOKEN=$(gcloud auth print-access-token)` for the active SA.
	const override = process.env.GCS_ACCESS_TOKEN;
	if (override) return override;
	if (!_authPromise) {
		_authPromise = (async () => {
			const { GoogleAuth } = await import("google-auth-library");
			const auth = new GoogleAuth({ scopes: [GCS_SCOPE] });
			return auth as unknown as { getAccessToken: () => Promise<string | null | undefined> };
		})();
	}
	const auth = await _authPromise;
	const token = await auth.getAccessToken();
	if (!token) {
		throw new Error(
			"GCS auth: google-auth-library returned no access token (no ADC / metadata credentials). " +
				"Locally, run `gcloud auth application-default login` or have an active SA; on Cloud Run the runtime SA is used automatically.",
		);
	}
	return token;
}

export function sha256hex(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/** Parse a gcs://bucket/key URI into its parts. Throws on a non-gcs scheme. */
export function parseGcsUri(uri: string): { bucket: string; key: string } {
	const m = /^gcs:\/\/([^/]+)\/(.+)$/.exec(uri.trim());
	if (!m) throw new Error(`not a gcs:// URI: ${uri}`);
	return { bucket: m[1], key: m[2] };
}

export function isGcsUri(uri: string): boolean {
	return /^gcs:\/\/[^/]+\/.+$/.test(uri.trim());
}

/**
 * Upload bytes to <bucket>/<sha256hex> and return the gcs:// URI. Content-
 * addressed: identical bytes always land at the same key, so re-uploads are
 * idempotent and the URI is self-verifying. `contentType` is advisory metadata.
 */
export async function putContent(
	bucket: string,
	bytes: Uint8Array,
	contentType = "application/octet-stream",
): Promise<string> {
	const key = sha256hex(bytes);
	const token = await accessToken();
	// JSON API media upload: POST .../o?uploadType=media&name=<key>. The object
	// body IS the raw bytes. (uploadType=media is the simple single-request form,
	// fine for spec.md and sealed submissions — both small.)
	const url =
		`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o` +
		`?uploadType=media&name=${encodeURIComponent(key)}`;
	const res = await fetch(url, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": contentType },
		// Pass an ArrayBuffer (a valid BodyInit) — a bare Uint8Array isn't accepted by
		// the fetch lib types. Slice to the view's exact window so we never upload a
		// pooled buffer's trailing bytes.
		body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
	});
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`GCS upload to ${bucket}/${key} failed ${res.status}: ${body.slice(0, 400)}`);
	}
	return `gcs://${bucket}/${key}`;
}

/**
 * Fetch the bytes behind a gcs:// URI. Verifies the content against the key
 * (sha256), so a corrupted or swapped object is caught loudly rather than
 * grading/decrypting tampered content.
 */
export async function getContent(uri: string): Promise<Uint8Array> {
	const { bucket, key } = parseGcsUri(uri);
	const token = await accessToken();
	const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(key)}?alt=media`;
	const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`GCS download ${uri} failed ${res.status}: ${body.slice(0, 400)}`);
	}
	const bytes = new Uint8Array(await res.arrayBuffer());
	// The key is the content's sha256 — re-derive and compare. A mismatch means
	// the object was swapped under a content-addressed key; treat as tampering.
	const got = sha256hex(bytes);
	if (got !== key) {
		throw new Error(`GCS content-address mismatch for ${uri}: object hashes to ${got}`);
	}
	return bytes;
}

/** Convenience: upload a UTF-8 string (e.g. spec.md) to a bucket. */
export async function putText(bucket: string, text: string, contentType = "text/markdown"): Promise<string> {
	return putContent(bucket, new TextEncoder().encode(text), contentType);
}

/** Convenience: fetch a gcs:// URI as UTF-8 text. */
export async function getText(uri: string): Promise<string> {
	return new TextDecoder().decode(await getContent(uri));
}
