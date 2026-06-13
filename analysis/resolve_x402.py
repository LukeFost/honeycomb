"""Resolve off-chain x402Support for ERC-8004 agents whose metadata lives off-chain (HTTPS/IPFS).

Reads erc8004_directory.csv (the BigQuery export), fetches each agent's registration file,
extracts x402Support + a few useful fields, and writes erc8004_directory_resolved.csv.

Cache: results are stored in .x402_cache.json keyed by URI so re-runs are instant and don't
re-hammer the gateways. Failures are surfaced loudly (printed) and recorded, not swallowed.
"""
import json, os, time
import urllib.request
from urllib.parse import urlparse
import pandas as pd

CACHE_PATH = ".x402_cache.json"
IPFS_GATEWAY = "https://ipfs.io/ipfs/"
HEADERS = {"User-Agent": "Mozilla/5.0 (ERC8004-directory/0.1; +bigquery-analysis)"}
TIMEOUT = 8

def load_cache():
    if os.path.exists(CACHE_PATH):
        with open(CACHE_PATH) as f:
            return json.load(f)
    return {}

def save_cache(c):
    with open(CACHE_PATH, "w") as f:
        json.dump(c, f, indent=2)

def to_http(uri: str) -> str:
    if uri.startswith("ipfs://"):
        return IPFS_GATEWAY + uri[len("ipfs://"):]
    return uri

def fetch_meta(uri: str) -> dict:
    """Fetch + parse one registration file. Returns a result dict (never raises)."""
    url = to_http(uri)
    try:
        req = urllib.request.Request(url, headers=HEADERS)
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            raw = resp.read(20000)
        doc = json.loads(raw.decode("utf-8", "replace"))
    except Exception as e:
        return {"status": "error", "error": f"{type(e).__name__}: {str(e)[:120]}"}

    # x402Support may be bool or string; normalize
    x = doc.get("x402Support")
    if isinstance(x, str):
        x = x.strip().lower() in ("true", "1", "yes")
    services = doc.get("services", [])
    svc_names = [s.get("name") for s in services if isinstance(s, dict)] if isinstance(services, list) else []
    return {
        "status": "ok",
        "name": doc.get("name"),
        "x402_support": bool(x) if x is not None else None,
        "active": doc.get("active"),
        "services": ",".join(filter(None, svc_names)),
        "supported_trust": ",".join(doc.get("supportedTrust", []) or []),
    }

def main():
    df = pd.read_csv("erc8004_directory.csv")
    cache = load_cache()

    rows = []
    n_fetched = 0
    for _, r in df.iterrows():
        uri = r["agent_uri"]
        rec = {"agent_id": int(r["agent_id"]), "avg_score": r["avg_score"],
               "unique_clients": int(r["unique_clients"]), "agent_uri": uri,
               "fully_onchain": bool(r["fully_onchain"])}

        # on-chain agents already resolved in SQL
        if r["x402"] in ("true", "false"):
            rec.update({"x402_resolved": (r["x402"] == "true"), "source": "onchain-sql",
                        "name": None, "services": None, "supported_trust": None})
            rows.append(rec); continue

        if not isinstance(uri, str) or not uri.startswith(("http", "ipfs://")):
            rec.update({"x402_resolved": None, "source": "unfetchable"})
            rows.append(rec); continue

        if uri in cache:
            meta = cache[uri]
        else:
            meta = fetch_meta(uri)
            cache[uri] = meta
            n_fetched += 1
            time.sleep(0.15)  # be polite to gateways
            if meta["status"] == "error":
                print(f"  ERR agent {rec['agent_id']:>6}  {urlparse(to_http(uri)).netloc}  {meta['error']}")

        if meta.get("status") == "ok":
            rec.update({"x402_resolved": meta.get("x402_support"), "source": "offchain-fetch",
                        "name": meta.get("name"), "services": meta.get("services"),
                        "supported_trust": meta.get("supported_trust")})
        else:
            rec.update({"x402_resolved": None, "source": "fetch-error", "name": None})
        rows.append(rec)

    save_cache(cache)
    out = pd.DataFrame(rows)
    out.to_csv("erc8004_directory_resolved.csv", index=False)

    # summary
    total = len(out)
    payable = (out["x402_resolved"] == True).sum()
    notpay = (out["x402_resolved"] == False).sum()
    unknown = out["x402_resolved"].isna().sum()
    print(f"\nfetched {n_fetched} new (rest cached)")
    print(f"resolved {total} agents: {payable} payable | {notpay} not-payable | {unknown} still unknown")
    print(f"by source:\n{out['source'].value_counts().to_string()}")
    print("\nwrote erc8004_directory_resolved.csv")
    return out

if __name__ == "__main__":
    main()
