#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), "utf8");

let failures = 0;
const ok = (label) => console.log(`ok - ${label}`);
const fail = (label, detail) => {
  failures += 1;
  console.error(`not ok - ${label}`);
  if (detail) console.error(`  ${detail}`);
};

function includes(path, needle, label = `${path} includes ${needle}`) {
  const text = read(path);
  if (text.includes(needle)) ok(label);
  else fail(label, `missing ${JSON.stringify(needle)}`);
}

function notIncludes(path, needles, label = `${path} has no forbidden strings`) {
  const text = read(path);
  const hits = needles.filter((needle) => text.includes(needle));
  if (hits.length === 0) ok(label);
  else fail(label, `found forbidden strings: ${hits.map((h) => JSON.stringify(h)).join(", ")}`);
}

function regex(path, pattern, label = `${path} matches ${pattern}`) {
  const text = read(path);
  if (pattern.test(text)) ok(label);
  else fail(label, `missing pattern ${pattern}`);
}

const submit = "apps/honeycomb-mcp/tools/submitWork.ts";
const grade = "apps/grading-cre/grader/grade.ts";
const mcpGrade = "apps/honeycomb-mcp/tools/grade.ts";
const apiDockerfile = "apps/honeycomb-api/Dockerfile";
const apiDeploy = "apps/honeycomb-api/deploy.sh";
const apiServer = "apps/honeycomb-api/server.ts";

// Submit path: direct receipt semantics and no CRE relay.
notIncludes(
  submit,
  ["cre workflow", "CRE_API_KEY", "HONEYCOMB_CRE_TARGET", "submitTx =", "recordScore", "recordValidity"],
  "submit_work does not invoke CRE or on-chain recording helpers",
);
includes(submit, 'recordedOnChain: false', "submit_work reports that it did not mutate escrow state");
includes(submit, 'recordingMode: "direct"', "submit_work reports direct recording mode");
includes(submit, 'isLeader: false', "submit_work does not fabricate live leaderboard leadership");
includes(submit, 'wouldBeLeader', "submit_work still reports whether the grade would beat current best");
includes(submit, 'encCid: null', "submit_work keeps old encCid field explicit/null");
includes(submit, 'submitTx: null', "submit_work keeps old tx field explicit/null");
includes(submit, 'scoreTx: null', "submit_work keeps old score tx field explicit/null");
includes(submit, 'validityTx: null', "submit_work keeps old validity tx field explicit/null");
includes(submit, 'sha256: createHash("sha256").update(bytes).digest("hex")', "submit_work receipts exact file bytes");
regex(submit, /const \{ resolvedPath, \.\.\.submission \} = submissionFile;/, "submit_work keeps resolved server path internal");
includes(submit, 'submissionPath: resolvedPath', "submit_work grades the same resolved file it hashes");
includes(submit, 'resolve(REPO_ROOT, submissionPath)', "submit_work prefers repo-relative paths");
includes(submit, 'resolve(GRADING_CRE_ROOT, submissionPath)', "submit_work preserves old grader-relative shorthand");
includes(submit, 'realpathSync(candidatePath)', "submit_work resolves symlinks before accepting a path");
includes(submit, 'submissionPath escapes the Honeycomb repo', "submit_work rejects traversal/symlink escapes outside the repo");
includes(submit, 'relative(root, candidate)', "submit_work uses containment checks rather than prefix string checks");

// Grading defaults: direct/unattested unless explicitly opted in.
includes(grade, 'const ENABLE_CONFIDENTIAL_AI = process.env.HONEYCOMB_ENABLE_CONFIDENTIAL_AI === "1"', "legacy AI validity requires explicit opt-in flag");
includes(grade, 'mode: "direct-unattested" as const', "grade.ts default validity is explicit direct-unattested");
includes(grade, 'const attestationDigest = sha256hex(`direct-validity|${filename}|${sha256hex(code)}`);', "grade.ts still emits a deterministic direct validity receipt");
includes(grade, 'validityAttestation: validity.attestationDigest', "grade.ts returns the selected validity digest");
includes(mcpGrade, 'const ENABLE_ENCLAVE_GRADING = process.env.HONEYCOMB_ENABLE_ENCLAVE_GRADING === "1"', "enclave grading requires explicit opt-in flag");
includes(mcpGrade, 'realpathSync(candidate)', "grade_submission resolves symlinks before grading a path");
includes(mcpGrade, 'submissionPath escapes the Honeycomb repo', "grade_submission rejects traversal/symlink escapes outside the repo");

// API runtime/deploy script: no CRE install/secret/target in the active deploy path this PR can update.
notIncludes(apiDockerfile, ["CRE_VERSION", "@chainlink/cre-sdk", "cre workflow", "grading-workflow bun", "cre CLI"], "API Dockerfile no longer installs CRE runtime pieces");
notIncludes(apiDeploy, ["CRE_API_KEY", "HONEYCOMB_CRE_TARGET", "cre workflow", "cre CLI"], "API deploy script no longer mounts CRE runtime metadata");
notIncludes(apiServer, ["CRE_API_KEY", "HONEYCOMB_CRE_TARGET", "cre workflow simulate"], "API server has no CRE runtime dependency");
includes(apiServer, "user-owned work receipt", "API /submit documents the direct receipt boundary");

if (failures) {
  console.error(`\n${failures} direct-submit guard(s) failed.`);
  process.exit(1);
}

console.log("\nAll direct-submit guards passed.");
