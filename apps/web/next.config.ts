import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep the BigQuery SDK external to the server bundle (it's a Node library with native-ish
  // deps); the data layer and routes load it via dynamic import.
  serverExternalPackages: ["@google-cloud/bigquery"],
  // Allow a second instance to use its own build dir (defaults to .next, so normal runs are
  // unchanged). Used to run a verification instance alongside a dev server without clobbering
  // its .next — e.g. NEXT_DISTDIR=.next-verify next dev -p 3001. See tools/chain-verify.
  distDir: process.env.NEXT_DISTDIR || ".next",
};

export default nextConfig;
