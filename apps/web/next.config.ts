import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep the BigQuery SDK external to the server bundle (it's a Node library with native-ish
  // deps); the data layer and routes load it via dynamic import.
  serverExternalPackages: ["@google-cloud/bigquery"],
};

export default nextConfig;
