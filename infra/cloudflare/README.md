# Cloudflare Workers — honeycompute.com edge

Two Workers front the custom domain. Snapshotted here from the live edge (verified
byte-identical) so they are recoverable; routes still live in the Cloudflare dashboard.

```
honeycompute.com        --(honeycomb-apex-redirect)-->  301  www.honeycompute.com
www.honeycompute.com    --(honeycomb-proxy)---------->  honeycomb-web-unovcqov3a-uc.a.run.app
```

## Why these never need editing on deploy

`honeycomb-proxy` points at the **stable Cloud Run service URL**, not a revision-pinned
one. Cloud Run keeps that hostname constant for the life of the service and shifts 100%
of traffic to the newest revision behind it. So a CI deploy (`.github/workflows/deploy.yml`)
that ships `honeycomb-web-00003`, `00004`, ... is picked up automatically — no Worker change.

Edit a Worker only if the Cloud Run **service** is renamed/moved, or the domain changes.

## Files

| File | Worker | Role |
| --- | --- | --- |
| `honeycomb-proxy.js` | `honeycomb-proxy` | reverse-proxy www -> Cloud Run web origin |
| `honeycomb-apex-redirect.js` | `honeycomb-apex-redirect` | 301 apex -> www |
| `wrangler.toml` | both (named envs) | redeploy config |

## Redeploy

```sh
cd infra/cloudflare
export CLOUDFLARE_API_TOKEN=$(security find-generic-password -s honeycomb_cloudflare_workers_token -w)
npx wrangler deploy --env proxy
npx wrangler deploy --env apex
```

No secrets live in these files. The API token is read from the keychain at deploy time.
