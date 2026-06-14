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
#     Confidential Space enclave (the enclave returns the signed SCORE; validity
#     stays local) -- see apps/honeycomb-mcp/tools/grade.ts,
#   - the `cre` CLI: /submit broadcasts the grade through the CRE grading-workflow
#     via `cre workflow simulate --broadcast` (apps/honeycomb-mcp/tools/submitWork.ts),
#   - apps/grading-cre (grader/ + grading-workflow/) -- EXCLUDED from the pnpm
#     workspace (it's a Bun + CRE-WASM project), so it gets its own `bun install`.
#
# NO secrets are baked in. SEP_PRIVATE_KEY / INFERENCE_API_KEY_VAR / CRE_API_KEY /
# SEPOLIA_RPC arrive at runtime from Secret Manager (deploy.sh --set-secrets). The
# runtime SA reads BigQuery for /reputation via ADC.
#
# Build context is the REPO ROOT (workspace lockfile + cross-package source).
#   docker build -f apps/honeycomb-api/Dockerfile -t honeycomb-api .
# ---------------------------------------------------------------------------

# Pin the cre CLI to the version proven locally (v1.20.0). bookworm is glibc 2.36,
# so the NON-ldd2-35 linux_amd64 asset is the right one.
ARG CRE_VERSION=v1.20.0

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
# Stage 2: runtime -- Bun + python venv + cre CLI + all source.
# =========================================================================
FROM oven/bun:1-debian AS runtime
ARG CRE_VERSION
WORKDIR /repo

# --- system python (the venv base) + tools to fetch the cre CLI ----------
# python3 + venv for the grader; ca-certificates/curl to pull the cre release;
# build-essential is NOT needed (zelos-demeter/pandas/numpy ship manylinux wheels).
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv python3-pip ca-certificates curl tar \
    && rm -rf /var/lib/apt/lists/*

# --- cre CLI (linux_amd64, by pinned version) ----------------------------
# /submit shells to `cre`. Pull the release tarball, extract the versioned binary,
# install to /usr/local/bin. bookworm glibc 2.36 -> plain linux_amd64 (not ldd2-35).
# The tarball extracts to a SINGLE file named cre_<TAG>_linux_amd64 where <TAG> keeps
# the leading "v" (e.g. cre_v1.20.0_linux_amd64) -- it's the binary itself, not a dir.
# So use ${CRE_VERSION} (=v1.20.0) verbatim, NOT ${CRE_VERSION#v} (which dropped the v
# and made `mv` fail: "cannot stat '/tmp/cre_1.20.0_linux_amd64'").
RUN curl -fsSL -o /tmp/cre.tar.gz \
      "https://github.com/smartcontractkit/cre-cli/releases/download/${CRE_VERSION}/cre_linux_amd64.tar.gz" \
    && tar -xzf /tmp/cre.tar.gz -C /tmp \
    && mv "/tmp/cre_${CRE_VERSION}_linux_amd64" /usr/local/bin/cre \
    && chmod +x /usr/local/bin/cre \
    && rm /tmp/cre.tar.gz \
    && cre version

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

# --- grading-cre (grader source + private-free; EXCLUDED from the workspace) ---
# The grader subprocess (grade.ts/grade legs) and the cre relay (grading-workflow)
# live here. Copy the whole app, then give grading-workflow its own bun install so
# `cre workflow simulate` resolves @chainlink/cre-sdk + the cre-setup postinstall.
# .dockerignore drops the host .venv / node_modules / private price series.
COPY apps/grading-cre ./apps/grading-cre
RUN cd apps/grading-cre/grading-workflow && bun install --frozen-lockfile

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
