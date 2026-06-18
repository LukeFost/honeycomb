// honeycomb-proxy: reverse-proxy www.honeycompute.com -> Cloud Run run.app origin.
// Host-header trap fix: rewrite the URL hostname to the run.app host; the runtime
// sets the Host header from the URL (Host cannot be set manually on outbound fetch).
//
// BACKEND is the STABLE Cloud Run service URL — it does NOT change across deploys
// (only the revision name increments), so this worker never needs editing when CI
// ships a new revision. Edit only if the web service is renamed or moved.
export default {
  async fetch(request) {
    const BACKEND = "honeycomb-web-unovcqov3a-uc.a.run.app";
    const url = new URL(request.url);
    url.hostname = BACKEND;
    url.protocol = "https:";
    url.port = "";
    const backendRequest = new Request(url.toString(), {
      method: request.method,
      headers: request.headers,
      body: (request.method === "GET" || request.method === "HEAD") ? undefined : request.body,
      redirect: "manual",
    });
    return fetch(backendRequest);
  },
};
