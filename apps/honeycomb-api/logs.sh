#!/usr/bin/env bash
# Tail / read the deployed Honeycomb services' logs straight from Google Cloud
# Logging, from a terminal — no GCP console, no Google Drive (Cloud Run ships every
# stdout/stderr line here automatically; this just reads it back).
#
# This is the operator's counterpart to the in-app GET /logs route: same logs,
# different surface. Use /logs (or the web /ops panel) for a redacted, shareable
# view; use THIS when you're debugging and want raw, follow-mode output in a shell.
#
# Auth: uses whatever account `gcloud` is configured for. That must be the OWNER SA
# (bq-script@honeycomb-499305) — the rights-less user account (lukefosteraz@) gets
# 403 "Permission denied for all log views". Check with `gcloud config get-value
# account`; switch with `gcloud config set account bq-script@honeycomb-499305...`.
#
# NOTE: unlike GET /logs, this does NO redaction — it's raw. That's intentional for
# local debugging, but it means: don't pipe this to anywhere public or paste it
# verbatim into a shared channel without a glance for secrets.
#
# Usage:
#   ./logs.sh                      # follow honeycomb-api live (tail -f style)
#   ./logs.sh web                  # follow honeycomb-web
#   ./logs.sh api read             # last 60 min of honeycomb-api, then exit
#   ./logs.sh api read 2h          # last 2 hours, then exit (freshness arg: 30m/2h/1d)
#   ./logs.sh api read 1h ERROR    # last 1h, only severity >= ERROR
#
# First positional: service  (api|web, or a full Cloud Run service name). Default api.
# Second positional: mode     (tail|read). Default tail (live follow).
# Third positional:  freshness (read mode only, e.g. 30m/2h/1d). Default 1h.
# Fourth positional: severity  (read mode only, e.g. WARNING/ERROR). Optional.
set -euo pipefail

PROJECT="${HONEYCOMB_GCP_PROJECT:-honeycomb-499305}"

# Resolve the service alias to a Cloud Run service name.
case "${1:-api}" in
	api|honeycomb-api|"") SERVICE="honeycomb-api" ;;
	web|honeycomb-web)    SERVICE="honeycomb-web" ;;
	*)                    SERVICE="$1" ;; # pass through a full service name
esac
MODE="${2:-tail}"
FRESHNESS="${3:-1h}"
SEVERITY="${4:-}"

# Guard: the active gcloud account must be able to read logs. The user account
# can't; the OWNER SA can. Warn (don't hard-fail — an impersonation/ADC setup
# might still work) so a 403 is self-explaining.
ACCOUNT="$(gcloud config get-value account 2>/dev/null || true)"
case "$ACCOUNT" in
	*gserviceaccount.com) : ;; # an SA — good
	*) echo "[logs.sh] WARNING: gcloud account is '$ACCOUNT', not a service account." >&2
	   echo "[logs.sh] If you hit 403 'Permission denied for all log views', switch to the OWNER SA:" >&2
	   echo "[logs.sh]   gcloud config set account bq-script@honeycomb-499305.iam.gserviceaccount.com" >&2 ;;
esac

echo "[logs.sh] service=$SERVICE project=$PROJECT mode=$MODE" >&2

if [ "$MODE" = "tail" ]; then
	# Live follow. `gcloud beta run services logs tail` streams new entries as they
	# land, scoped to the service. (Requires the gcloud beta component; if it's
	# missing, gcloud prompts to install it.)
	exec gcloud beta run services logs tail "$SERVICE" \
		--project="$PROJECT" --region="${HONEYCOMB_REGION:-us-central1}"
fi

# read mode: a bounded historical pull, newest first, then exit. The time window is
# `--freshness` (gcloud's own relative-age flag, e.g. 30m/2h/1d) — NOT a timestamp>=
# clause, which gcloud rejects alongside --freshness; the filter stays timestamp-free.
FILTER="resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"$SERVICE\""
if [ -n "$SEVERITY" ]; then
	FILTER="$FILTER AND severity>=${SEVERITY}"
fi
exec gcloud logging read "$FILTER" \
	--project="$PROJECT" \
	--freshness="$FRESHNESS" \
	--order=desc \
	--limit="${HONEYCOMB_LOG_LIMIT:-100}" \
	--format="table(timestamp, severity, textPayload, jsonPayload.message)"
