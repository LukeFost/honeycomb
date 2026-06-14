# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# Honeycomb dashboard (apps/web) -> Cloud Run.
#
# Build context is the REPO ROOT (so the workspace lockfile is available for a
# pinned install), but only apps/web is built and only its Next standalone output
# ships in the runtime image. No service-account key is ever copied in — BigQuery
# auth on Cloud Run uses the bound runtime SA via ADC (see src/lib/bqClient.ts).
#
# Build + run from the repo root:
#   docker build -f apps/web/Dockerfile -t honeycomb-web .
#   docker run -p 8080:8080 -e BQ_ESCROW_ADDRESS=0x... -e BQ_BILLING_PROJECT=... honeycomb-web
# ---------------------------------------------------------------------------

# --- deps: pinned install from the workspace lockfile ----------------------
FROM node:22-slim AS deps
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@9.14.2 --activate
# Copy just the manifests the web filter needs so the install layer caches across code edits.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
# Install ONLY the web package's dependency closure, pinned to the workspace lockfile.
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --filter web... --frozen-lockfile

# --- build: compile the Next standalone bundle -----------------------------
FROM node:22-slim AS build
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@9.14.2 --activate
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/apps/web/node_modules ./apps/web/node_modules
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web ./apps/web
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter web build

# --- runtime: slim image, standalone server only ---------------------------
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=8080 \
    HOSTNAME=0.0.0.0
# Run as the unprivileged node user baked into the base image.
USER node
# Next standalone output: server + traced node_modules, then static + public alongside it.
COPY --chown=node:node --from=build /repo/apps/web/.next/standalone ./
COPY --chown=node:node --from=build /repo/apps/web/.next/static ./apps/web/.next/static
COPY --chown=node:node --from=build /repo/apps/web/public ./apps/web/public
EXPOSE 8080
# Standalone traces the monorepo path, so server.js sits under apps/web/.
CMD ["node", "apps/web/server.js"]
