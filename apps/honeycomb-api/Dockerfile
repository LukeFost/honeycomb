# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# Honeycomb HTTP API (apps/honeycomb-api) -> Cloud Run.
#
# This is the FULL backend: unlike the web dashboard (read-only BigQuery), the API
# owns the write+grade+submit surface, so the image must carry every heavy dep the
# routes shell out to:
#   - the Bun runtime + the pnpm workspace (server.ts imports honeycomb-mcp +
#     @honeycomb/chain as workspace packages),
#   - the grader's python venv (zelos-demeter==1.3.0): /grade ALWAYS runs the local
#     validity scorer via `python3` even when GRADER_ENCLAVE_URL points at the
#     Confidential Space enclave only when HONEYCOMB_ENABLE_ENCLAVE_GRADING=1;
#     direct mode stays local by default) -- see apps/honeycomb-mcp/tools/grade.ts,
#   - apps/grading-cre/grader -- the scoring source used by the direct submit path.
#
# NO secrets are baked in. SEP_PRIVATE_KEY / INFERENCE_API_KEY_VAR / SEPOLIA_RPC
# arrive at runtime from Secret Manager (deploy.sh --set-secrets). The runtime SA
# reads BigQuery for /reputation via ADC.
#
# Build context is the REPO ROOT (workspace lockfile + cross-package source).
#   docker build -f apps/honeycomb-api/Dockerfile -t honeycomb-api .
# ---------------------------------------------------------------------------

# =========================================================================
# Stage 1: pnpm workspace install (api + honeycomb-mcp + @honeycomb/chain).
# Bun runs server.ts from source; it needs the workspace's node_modules (viem etc).
# =========================================================================
FROM node:22-bookworm-slim AS workspace
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@9.14.2 --activate
# Manifests first so the install layer caches across source edits. The api's
# dependency closure pulls honeycomb-mcp + @honeycomb/chain (workspace:*).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/honeycomb-api/package.json apps/honeycomb-api/package.json
COPY apps/honeycomb-mcp/package.json apps/honeycomb-mcp/package.json
COPY packages/chain/package.json packages/chain/package.json
# Full workspace install (NOT --filter): server.ts crosses honeycomb-mcp ->
# @honeycomb/chain and Bun resolves the symlinked workspace tree at runtime.
RUN pnpm install --frozen-lockfile

# =========================================================================
# Stage 2: runtime -- Bun + python venv + all source.
# =========================================================================
FROM oven/bun:1-debian AS runtime
WORKDIR /repo

# --- system python (the venv base) ---------------------------------------
# python3 + venv for the grader.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv python3-pip ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# --- grader python venv (zelos-demeter) ----------------------------------
# grade.ts prepends HONEYCOMB_GRADER_VENV/bin (default apps/grading-cre/grader/.venv)
# to PATH and runs `python3`. Rebuild that venv in-image with the pinned deps the
# scorer imports (demeter + the kms/eth libs the enclave_grade path also uses).
ENV GRADER_VENV=/repo/apps/grading-cre/grader/.venv
RUN python3 -m venv "$GRADER_VENV" \
    && "$GRADER_VENV/bin/pip" install --no-cache-dir --upgrade pip \
    && "$GRADER_VENV/bin/pip" install --no-cache-dir \
         zelos-demeter==1.3.0 \
         google-cloud-kms==2.* \
         google-cloud-bigquery==3.* \
         eth-keys==0.5.* \
         "eth-hash[pycryptodome]" \
    && "$GRADER_VENV/bin/python" -c "import demeter, pandas, numpy; from google.cloud import bigquery; print('venv OK')"

# --- workspace node_modules (from stage 1) -------------------------------
COPY --from=workspace /repo/node_modules ./node_modules
COPY --from=workspace /repo/apps/honeycomb-api/node_modules ./apps/honeycomb-api/node_modules
COPY --from=workspace /repo/apps/honeycomb-mcp/node_modules ./apps/honeycomb-mcp/node_modules
# NOTE: no packages/chain/node_modules COPY -- @honeycomb/chain has ZERO deps (sepolia.ts
# imports only node:child_process), so pnpm creates no node_modules for it. The workspace
# symlink that resolves "@honeycomb/chain" lives in the CONSUMERS' node_modules/@honeycomb/
# (api + mcp, copied above) and the root store, both already present. Copying a path pnpm
# never creates fails the build with "not found".

# --- source: the api + the engine + the chain pkg + the skill ------------
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/honeycomb-api ./apps/honeycomb-api
COPY apps/honeycomb-mcp ./apps/honeycomb-mcp
COPY packages/chain ./packages/chain
# /skill reads .claude/skills/honeycomb/SKILL.md (four levels up from server.ts).
COPY .claude/skills/honeycomb ./.claude/skills/honeycomb

# --- grading-cre (grader source; EXCLUDED from the workspace) -------------
# The grader subprocess (grade.ts/scorers) lives here. Copy the app so direct
# grade/submit can run the real scorer. No CRE workflow install is needed for the
# API runtime anymore.
# .dockerignore drops the host .venv / node_modules / private price series.
COPY apps/grading-cre ./apps/grading-cre

# --- runtime config ------------------------------------------------------
# Cloud Run sends traffic to $PORT (8080). Bind 0.0.0.0 so it's reachable; the
# write routes are guarded by HONEYCOMB_API_TOKEN (set at deploy).
# HONEYCOMB_PYTHON points reputation.ts at the grader venv python (which now carries
# google-cloud-bigquery). Without it, reputation.ts falls back to bare python3 -- the
# system interpreter that has no `google` package -> /reputation 500s. There is no
# analysis/.venv in this image (analysis/ is not copied), so this override is required.
ENV PORT=8080 \
    HOST=0.0.0.0 \
    HONEYCOMB_GRADER_VENV=/repo/apps/grading-cre/grader/.venv/bin \
    HONEYCOMB_PYTHON=/repo/apps/grading-cre/grader/.venv/bin/python \
    PYTHONDONTWRITEBYTECODE=1
EXPOSE 8080

# server.ts is the bin. Run from the api dir so its relative path math
# (../../grading-cre, ../../.claude) resolves the same as a local checkout.
WORKDIR /repo/apps/honeycomb-api
CMD ["bun", "server.ts"]
