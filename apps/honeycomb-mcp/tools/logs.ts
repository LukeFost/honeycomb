// ============================================================================
// logs.ts — read recent Cloud Logging entries for the deployed services.
//
// Cloud Run ships everything a service writes to stdout/stderr to Google Cloud
// Logging automatically (no app change). This tool reads those entries back via
// the Logging REST API (entries:list) so an operator can see what a deployed
// service is doing WITHOUT opening the GCP console or shelling to `gcloud`.
//
// Auth mirrors storage/gcs.ts: google-auth-library is Node-only and works on
// BOTH Cloud Run (the runtime SA via the metadata server) and locally (ADC /
// the active gcloud SA). The runtime SA (bq-script@, Owner) can read logs. A
// failed token mint or a non-2xx from the API THROWS — per the loud-failure
// rule we never return a quiet empty list that masks an auth/permission problem.
//
// SECURITY: /logs is PUBLIC (anyone can read it, incl. demo viewers) — there is
// no token gate. So safety lives HERE, at the one chokepoint every line passes
// through: redact() scrubs secrets (API keys in RPC URLs, bearer tokens,
// private-key-shaped hex) out of each line before it leaves this module. Public
// data stays visible on purpose — wallet addresses, tx hashes, agentIds, request
// paths, and error messages are all on-chain or harmless and make the logs
// useful for debugging/demoing. Belt-and-suspenders: callers (e.g. the subscriber)
// already redact RPC secrets at WRITE time; this scrubs again at READ time so a
// future code path that dumps a secret can't leak it through this endpoint.
// ============================================================================

const LOGGING_SCOPE = "https://www.googleapis.com/auth/logging.read";

// GCP project whose logs we read. On Cloud Run the metadata server also exposes
// this, but we keep it explicit (and overridable) so a local run targets the
// same project the services deploy to.
const PROJECT_ID =
	process.env.HONEYCOMB_GCP_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT ?? "honeycomb-499305";

// The Cloud Run services whose logs are readable. Anything not in this set is
// rejected so a caller can't craft an arbitrary Logging filter through us.
const KNOWN_SERVICES = new Set(["honeycomb-api", "honeycomb-web"]);
const DEFAULT_SERVICE = "honeycomb-api";

let _authPromise: Promise<{ getAccessToken: () => Promise<string | null | undefined> }> | null = null;

async function accessToken(): Promise<string> {
	// Explicit override (a pre-minted token), same escape hatch as gcs.ts: lets a
	// local/CI run read logs as a specific SA without the ADC well-known file —
	// e.g. LOGS_ACCESS_TOKEN=$(gcloud auth print-access-token).
	const override = process.env.LOGS_ACCESS_TOKEN;
	if (override) return override;
	if (!_authPromise) {
		_authPromise = (async () => {
			const { GoogleAuth } = await import("google-auth-library");
			const auth = new GoogleAuth({ scopes: [LOGGING_SCOPE] });
			return auth as unknown as { getAccessToken: () => Promise<string | null | undefined> };
		})();
	}
	const auth = await _authPromise;
	const token = await auth.getAccessToken();
	if (!token) {
		throw new Error(
			"Cloud Logging auth: google-auth-library returned no access token (no ADC / metadata credentials). " +
				"Locally, run `gcloud auth application-default login` or have an active SA; on Cloud Run the runtime SA is used automatically.",
		);
	}
	return token;
}

export type LogEntry = {
	timestamp: string | null;
	severity: string;
	// The human-readable line: textPayload, or the message/stringified jsonPayload.
	text: string;
	revision: string | null;
};

export type ReadLogsArgs = {
	/** Which Cloud Run service's logs to read (default honeycomb-api). */
	service?: string;
	/** Max entries to return (1..1000, default 100). */
	limit?: number;
	/** Lookback window in minutes (default 60). */
	sinceMinutes?: number;
	/** Only return entries at or above this severity (e.g. WARNING, ERROR). */
	minSeverity?: string;
	/** Case-insensitive substring the entry text must contain. */
	contains?: string;
};

// Cloud Logging severities, ordered. Used to build a >= filter from minSeverity.
const SEVERITIES = ["DEFAULT", "DEBUG", "INFO", "NOTICE", "WARNING", "ERROR", "CRITICAL", "ALERT", "EMERGENCY"];

// Secret-scrubbing for the PUBLIC /logs route. Each pattern targets a SECRET
// shape, not public data: we deliberately keep 40-hex wallet addresses visible
// (they're on-chain) and only kill things that grant access. A 64-hex run is the
// one ambiguous case — a private key AND a tx/block hash are both 32 bytes — so we
// scrub it: leaking a key is catastrophic, losing a hash from a log line is not.
// Order matters — URL-embedded keys first, then header tokens, then 64-hex blobs,
// then the multi-word mnemonic, then the generic KEY=VALUE catch-all. Replacement
// keeps enough context to read the line.
const REDACTIONS: Array<[RegExp, string]> = [
	// RPC / API URLs with the key in the PATH: .../v2/<key>, .../v3/<key>, infura, etc.
	// Keep host + version segment, drop the trailing key. Covers http(s) AND ws(s)
	// — the subscriber's RPC endpoint is a wss:// URL with the key in the path.
	[/(\b(?:https?|wss?):\/\/[^\s/]+\/v\d+\/)[A-Za-z0-9_-]{12,}/gi, "$1<redacted>"],
	// Keys passed as query params: ?key=, &apikey=, &access_token=, &token=
	[/([?&](?:api[_-]?key|key|access_token|token|secret)=)[^&\s"']+/gi, "$1<redacted>"],
	// Authorization headers / bearer tokens in any logged request dump.
	[/(\b[Bb]earer\s+)[A-Za-z0-9._\-+/=]{8,}/g, "$1<redacted>"],
	[/("?[Aa]uthorization"?\s*[:=]\s*"?)(?:[Bb]earer\s+)?[A-Za-z0-9._\-+/=]{8,}/g, "$1<redacted>"],
	// A private key shape: 0x + 64 hex, or a bare 64-hex run. A wallet address is
	// 40 hex, so this {64} length specifically targets keys, not addresses. We use
	// lookarounds instead of \b to require the run is EXACTLY 64 hex and not a slice
	// of a longer hex blob (a 33-byte+ value, or a tx-data dump) — a 65th hex digit
	// on either side means it isn't a 32-byte key, so we leave it alone to avoid
	// mangling legitimate long hex. Residual (accepted): a key fused letter-to-letter
	// into surrounding text with NO delimiter AND a hex letter immediately adjacent
	// (…E<64hex>…) is missed, because that adjacency reads as one longer run. This
	// shape does not occur in Cloud Run logs (lines are whitespace/JSON delimited);
	// the env dumps / JSON fields / "0x"-prefixed forms that DO occur are all caught.
	[/0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/g, "0x<redacted-32-bytes>"],
	[/(?<![0-9a-fA-Fx])[0-9a-fA-F]{64}(?![0-9a-fA-F])/g, "<redacted-32-bytes>"],
	// A BIP-39 mnemonic / seed phrase IS a private key (it derives the whole wallet),
	// and its value is space-separated words — so the generic KEY=VALUE rule below
	// (which stops the value at the first space) would leak words 2..N. Capture the
	// whole run of lowercase words after a mnemonic/seed-phrase label. Matched BEFORE
	// the generic KV rule so the label isn't half-consumed.
	[/("?\b(?:mnemonic|seed[_-]?phrase|recovery[_-]?phrase)"?\s*[:=]\s*"?)[a-z0-9]+(?:[\s,]+[a-z0-9]+){5,}/gi, "$1<redacted>"],
	// Anything that names itself a secret/key in a KEY=VALUE / "key": "value" pair.
	// Case-insensitive so both an env dump (INFERENCE_API_KEY=...) and a JSON field
	// ("password":"...") are caught; quoted-key form is handled by the optional "?.
	// "mnemonic"/"seedphrase" are also listed here to catch the single-token forms.
	[/("?\b\w*(?:private[_-]?key|secret|api[_-]?key|token|password|mnemonic|seed[_-]?phrase|passphrase)\w*"?\s*[:=]\s*"?)[^\s",}]+/gi, "$1<redacted>"],
];

/** Scrub secrets out of a log line before it leaves this module. */
function redact(text: string): string {
	let out = text;
	for (const [re, repl] of REDACTIONS) out = out.replace(re, repl);
	return out;
}

/** Flatten one Logging API entry into a single readable line. */
function shapeEntry(e: Record<string, unknown>): LogEntry {
	const resource = (e.resource ?? {}) as { labels?: Record<string, string> };
	let text = "";
	if (typeof e.textPayload === "string") {
		text = e.textPayload;
	} else if (e.jsonPayload && typeof e.jsonPayload === "object") {
		const jp = e.jsonPayload as Record<string, unknown>;
		text = typeof jp.message === "string" ? jp.message : JSON.stringify(jp);
	} else if (typeof e.protoPayload === "object" && e.protoPayload) {
		text = JSON.stringify(e.protoPayload);
	}
	return {
		timestamp: typeof e.timestamp === "string" ? e.timestamp : null,
		severity: typeof e.severity === "string" ? e.severity : "DEFAULT",
		text: redact(text),
		revision: resource.labels?.revision_name ?? null,
	};
}

/**
 * Read recent Cloud Logging entries for a deployed service, newest first.
 * Returns shaped { entries, ... } so the HTTP route / web panel render directly.
 * Throws on bad auth / unknown service / non-2xx — no silent empty fallback.
 */
export async function readLogs(args: ReadLogsArgs = {}): Promise<{
	service: string;
	project: string;
	sinceMinutes: number;
	count: number;
	entries: LogEntry[];
}> {
	const service = args.service ?? DEFAULT_SERVICE;
	if (!KNOWN_SERVICES.has(service)) {
		throw new Error(
			`unknown service "${service}" (readable: ${[...KNOWN_SERVICES].join(", ")})`,
		);
	}
	const limit = Math.min(Math.max(Math.floor(args.limit ?? 100), 1), 1000);
	const sinceMinutes = Math.min(Math.max(Math.floor(args.sinceMinutes ?? 60), 1), 60 * 24 * 7);

	// Build the Logging filter. Time bound is computed by the caller of this
	// module (server.ts passes the cutoff) — here we accept a relative window and
	// turn it into an absolute RFC-3339 timestamp at call time. Date math is fine
	// in this runtime (server.ts, not a workflow script).
	const cutoffMs = Date.now() - sinceMinutes * 60_000;
	const cutoffIso = new Date(cutoffMs).toISOString();

	const filterParts = [
		`resource.type="cloud_run_revision"`,
		`resource.labels.service_name="${service}"`,
		`timestamp>="${cutoffIso}"`,
	];
	if (args.minSeverity) {
		const sev = args.minSeverity.toUpperCase();
		if (!SEVERITIES.includes(sev)) {
			throw new Error(`invalid minSeverity "${args.minSeverity}" (one of: ${SEVERITIES.join(", ")})`);
		}
		filterParts.push(`severity>=${sev}`);
	}
	const filter = filterParts.join(" AND ");

	const token = await accessToken();
	const res = await fetch("https://logging.googleapis.com/v2/entries:list", {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
		body: JSON.stringify({
			resourceNames: [`projects/${PROJECT_ID}`],
			filter,
			// Newest first. The API caps page size; we ask for our limit directly.
			orderBy: "timestamp desc",
			pageSize: limit,
		}),
	});
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(
			`Cloud Logging entries:list failed ${res.status} for ${service}: ${body.slice(0, 400)}`,
		);
	}
	const data = (await res.json()) as { entries?: Record<string, unknown>[] };
	let entries = (data.entries ?? []).map(shapeEntry);

	// Optional substring filter, applied client-side so a caller can grep without
	// learning Logging's filter syntax. Case-insensitive.
	if (args.contains) {
		const needle = args.contains.toLowerCase();
		entries = entries.filter((e) => e.text.toLowerCase().includes(needle));
	}

	return { service, project: PROJECT_ID, sinceMinutes, count: entries.length, entries };
}
