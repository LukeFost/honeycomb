# Direct submit testing plan

This PR changes Honeycomb submission from a Chainlink/CRE-mediated path to a direct,
off-chain work receipt. The tests should prove two things:

1. active runtime code cannot silently fall back to CRE/relay/on-chain recording; and
2. direct submit returns an honest receipt contract that callers can reason about.

## Local required checks

Run these before pushing or merging a direct-submit change:

```bash
pnpm install --frozen-lockfile
pnpm test:direct-submit
git diff --check
bash -n apps/honeycomb-api/deploy.sh
pnpm --filter honeycomb-mcp typecheck
pnpm --filter honeycomb-api typecheck
pnpm build
```

Also check the plugin shim package independently because it is not part of the root
workspace:

```bash
TMP=$(mktemp -d /tmp/honeycomb-plugin-check-XXXXXX)
cp plugins/honeycomb/mcp/package.json plugins/honeycomb/mcp/tsconfig.json plugins/honeycomb/mcp/shim.ts "$TMP"/
(cd "$TMP" && pnpm install --ignore-workspace --no-frozen-lockfile && pnpm typecheck)
```

## What `pnpm test:direct-submit` covers

The guard script is intentionally zero-dependency Node so it can run anywhere the
repo builds. It fails if the active API/MCP/Docker/deploy-script path regresses on
these invariants:

- `submit_work` does not call `cre workflow`, mount `CRE_API_KEY`, use
  `HONEYCOMB_CRE_TARGET`, or call on-chain recording helpers.
- `submit_work` returns `recordedOnChain: false`, `recordingMode: "direct"`,
  explicit null tx/CID fields, and `wouldBeLeader` instead of fabricated
  `isLeader`.
- `submit_work` hashes the exact file bytes, keeps the server-resolved absolute
  path internal, grades the same resolved file it hashed, and rejects traversal or
  symlink escapes outside the repo.
- `grade_submission` also rejects traversal or symlink escapes before shelling to
  the grader.
- validity defaults to `direct-unattested`; legacy Confidential AI and enclave
  grading require explicit opt-in flags.
- the API Dockerfile and `apps/honeycomb-api/deploy.sh` do not install/mount CRE
  runtime pieces.

## Manual/API smoke test

When a machine has the real Honeycomb API token and a submission file available,
smoke-test `/submit` directly:

```bash
curl -fsS "$HONEYCOMB_API_URL/submit" \
  -H "authorization: Bearer $HONEYCOMB_API_TOKEN" \
  -H 'content-type: application/json' \
  --data '{
    "jobId": "1",
    "agentId": "22",
    "bounty": "directional",
    "submissionPath": "apps/grading-cre/grader/submissions/clean.py"
  }' | jq .
```

Expected response shape:

- `recordedOnChain` is `false`
- `recordingMode` is `"direct"`
- `submitTx`, `scoreTx`, `validityTx`, and `encCid` are `null`
- `submission.sha256` is present
- `wouldBeLeader` is a boolean
- `isLeader` is `false`
- no response field claims CRE broadcast or on-chain recording

This smoke test depends on live chain/API credentials and the deployed container
having the grader venv, so it is intentionally separate from the local PR checks.

## Known deployment metadata blocker

`.github/workflows/deploy.yml` still needs the same CRE cleanup as
`apps/honeycomb-api/deploy.sh`, but updating workflow files requires a GitHub token
with the `workflow` scope. The blocked patch is documented on PR #9. Until that is
applied, the workflow may still mount stale CRE env/secret metadata even though the
active API runtime no longer installs or calls CRE.
