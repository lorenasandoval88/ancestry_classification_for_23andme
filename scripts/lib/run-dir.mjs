// Locate the artifacts of one cloud run inside cloud/, the local mirror of
// gs://all23_0710/ancestry/my23_v5_ancestry_model/ (see cloud/README.md). Each step keeps
// <step>/{input,results,source}/<run_id>/; run-level files sit in runs/<run_id>/.
// The run is the one named in model/metadata.json (the published browser bundle) unless
// overridden with --run <id>; with no metadata.json the single folder under cloud/runs/ is used.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const m = argv[i].match(/^--([a-z0-9-]+)$/i);
    if (!m) throw new Error(`Unexpected argument: ${argv[i]}`);
    a[m[1]] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
  }
  return a;
}

export function readJsonIf(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

/**
 * @returns {{ runId, metadata, bucket, runDir, results(step), input(step), source(step?) }}
 *   results("6_test_model")        → cloud/6_test_model/results/<run_id>
 *   input("7_apply_v5_classifier") → cloud/7_apply_v5_classifier/input/<run_id>
 *   source()                       → cloud/source/<run_id>;  source(step) → cloud/<step>/source/<run_id>
 *   runDir                         → cloud/runs/<run_id>
 */
export function resolveRun(root, override) {
  const bucket = resolve(root, "cloud");
  const metadata = readJsonIf(resolve(root, "model/metadata.json"));
  let runId = override || metadata?.run_id;
  if (!runId) {
    const runsDir = join(bucket, "runs");
    const runs = existsSync(runsDir)
      ? readdirSync(runsDir).filter((d) => statSync(join(runsDir, d)).isDirectory())
      : [];
    if (runs.length !== 1) {
      throw new Error(`No run_id in model/metadata.json and ${runs.length} folders under cloud/runs/ — pass --run <id>`);
    }
    runId = runs[0];
  }
  const runDir = join(bucket, "runs", runId);
  if (!existsSync(runDir)) throw new Error(`cloud/runs/${runId}/ not found (run named in model/metadata.json or --run)`);
  return {
    runId,
    metadata,
    bucket,
    runDir,
    results: (step) => join(bucket, step, "results", runId),
    input: (step) => join(bucket, step, "input", runId),
    source: (step) => (step ? join(bucket, step, "source", runId) : join(bucket, "source", runId)),
  };
}
