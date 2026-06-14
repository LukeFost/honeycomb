// honeycomb-apex-redirect: 301 the apex honeycompute.com -> www.honeycompute.com,
// which the honeycomb-proxy worker then reverse-proxies to the Cloud Run web origin.
// Split from the proxy so the apex and www hostnames can carry different routes.
export default {
  async fetch(request) {
    const u = new URL(request.url);
    u.hostname = "www.honeycompute.com";
    u.protocol = "https:";
    return Response.redirect(u.toString(), 301);
  },
};
