"""Standalone BigQuery auth + config for the ERC-8004 analysis pipeline.

Importing this module makes the pipeline work without manual env setup or cross-repo
paths. On import it:
  1. loads a `.env` file (searching this dir up to the repo root), and
  2. if GOOGLE_APPLICATION_CREDENTIALS isn't set, points it at the repo-local
     service-account key at `<repo>/.secrets/gcp-key.json`.

The only secret is the JSON key (gitignored). The billing project comes from .env / the
BQ_BILLING_PROJECT env var; if unset, the client falls back to the key's own project.

Usage:
    import bqenv
    from google.cloud import bigquery
    client = bigquery.Client(project=bqenv.BILLING_PROJECT)
"""
import os
import pathlib

_HERE = pathlib.Path(__file__).resolve().parent


def _roots():
    """Yield this dir then ancestors, stopping at the git repo root."""
    yield _HERE
    for p in _HERE.parents:
        yield p
        if (p / ".git").is_dir():
            break


# 1. load .env (KEY=VALUE lines; existing environment wins via setdefault)
for _root in _roots():
    _envf = _root / ".env"
    if _envf.is_file():
        for _line in _envf.read_text().splitlines():
            _line = _line.strip()
            if not _line or _line.startswith("#") or "=" not in _line:
                continue
            _k, _v = _line.split("=", 1)
            os.environ.setdefault(_k.strip(), _v.strip().strip('"').strip("'"))
        break

# 2. resolve the service-account key by convention if not already configured
if not os.environ.get("GOOGLE_APPLICATION_CREDENTIALS"):
    for _root in _roots():
        _key = _root / ".secrets" / "gcp-key.json"
        if _key.is_file():
            os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = str(_key)
            break

BILLING_PROJECT = os.environ.get("BQ_BILLING_PROJECT")  # if unset, client uses the key's project
START = os.environ.get("BQ_START", "2026-05-14")
MAX_BYTES = int(os.environ.get("BQ_MAX_BYTES", 70_000_000_000))
