import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emit a self-contained server bundle (.next/standalone) with only the traced node_modules,
  // so the Cloud Run runtime image stays slim and needs no workspace install at runtime.
  output: "standalone",
  // Keep Node-only SDKs external to the server bundle. BigQuery is a Node library with
  // native-ish deps (data layer + routes load it via dynamic import). google-auth-library
  // is Node-only and is lazily imported by api/summon to mint a Confidential Space ID token
  // (only when ENCLAVE_ID_TOKEN_AUDIENCE is set); bundling it breaks its Node built-in use.
  serverExternalPackages: ["@google-cloud/bigquery", "google-auth-library"],
  // Allow a second instance to use its own build dir (defaults to .next, so normal runs are
  // unchanged). Used to run a verification instance alongside a dev server without clobbering
  // its .next — e.g. NEXT_DISTDIR=.next-verify next dev -p 3001. See tools/chain-verify.
  distDir: process.env.NEXT_DISTDIR || ".next",
};

export default nextConfig;
