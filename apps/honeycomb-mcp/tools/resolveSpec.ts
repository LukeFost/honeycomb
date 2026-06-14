// ============================================================================
// resolve_spec: fetch the public spec a bounty's specCid points at.
//
// A bounty's specCid is an off-chain pointer (see storage/gcs.ts). For bounties
// opened after the GCS content layer landed it's a `gcs://honeycomb-specs/<sha>`
// URI whose bytes ARE the spec markdown. This resolves that to text so an agent
// (or the dashboard) can read the requirements without a side channel.
//
// Back-compat: pre-GCS bounties carry a synthetic `honeycomb://<dir>/spec.md`
// pointer that was never backed by fetchable content. We can't materialize that
// here, so we return it as an unresolved pointer with `resolved:false` rather
// than throwing — the caller can show "spec not published" instead of erroring.
// ============================================================================

import { getText, isGcsUri } from "../storage/gcs.ts";

export const resolveSpecInput = {
	specCid: {
		type: "string",
		description:
			"The bounty's specCid (from get_job / list_jobs). A gcs:// URI resolves to the spec markdown; a legacy honeycomb:// pointer returns unresolved.",
	},
} as const;

export async function resolveSpec(args: { specCid: string }): Promise<{
	specCid: string;
	resolved: boolean;
	scheme: string;
	content?: string;
	note?: string;
}> {
	const specCid = (args.specCid ?? "").trim();
	if (!specCid) throw new Error("specCid is required");

	const scheme = specCid.split("://")[0] || "(none)";

	if (isGcsUri(specCid)) {
		const content = await getText(specCid); // throws loudly on 404 / tamper
		return { specCid, resolved: true, scheme: "gcs", content };
	}

	// Legacy / unbacked pointer — surface it honestly rather than faking content.
	return {
		specCid,
		resolved: false,
		scheme,
		note:
			scheme === "honeycomb"
				? "legacy honeycomb:// pointer — this bounty predates the GCS spec layer and has no fetchable spec content on-chain"
				: `unrecognized spec scheme '${scheme}' — only gcs:// is resolvable`,
	};
}
