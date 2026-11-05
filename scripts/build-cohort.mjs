// Build data/reference_cohort.json: the 1000 Genomes people used to train/test the
// ancestry classifier, joined with the public population panel and the Step 6 test-set
// evaluation of the published model.
//
//   node scripts/build-cohort.mjs [--run <run_id>]
//
// Reads the bucket mirror cloud/ for the run named in model/metadata.json (see cloud/README.md):
//   2_split_the_samples/input/<run>/train2003.txt, test501.txt   one sample ID per line
//   3_audit_pop_and_relatives/input/<run>/population.panel       sample  pop  super_pop  gender
//   3_audit_pop_and_relatives/results/<run>/audit_summary.json   population_panel_sha256 (verified)
//   6_test_model/input/<run>/input_manifest.json                 staged-input md5 of the panel (verified)
//   6_test_model/results/<run>/predictions.tsv     IID  population  actual_group  predicted_group  correct  prob_AFR … prob_SAS
//   6_test_model/results/<run>/test_summary.json   accuracy, balanced_accuracy, correct, selected_markers, run_id …
//   6_test_model/results/<run>/onnx_parity.json    max_probability_absolute_difference, same_predicted_labels, tolerance …
//   5_fit_pca_and_classifier/results/<run>/training_summary.json   selected_markers, best_parameters, cv_* …

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, readJsonIf, resolveRun } from "./lib/run-dir.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const run = resolveRun(root, args.run);
const inp = run.input("2_split_the_samples");
const out = resolve(root, "data/reference_cohort.json");

const POP_NAMES = {
  ACB: "African Caribbean in Barbados", ASW: "African Ancestry in Southwest US", BEB: "Bengali in Bangladesh",
  CDX: "Chinese Dai in Xishuangbanna", CEU: "Utah residents with Northern and Western European ancestry",
  CHB: "Han Chinese in Beijing", CHS: "Han Chinese South", CLM: "Colombian in Medellín", ESN: "Esan in Nigeria",
  FIN: "Finnish in Finland", GBR: "British in England and Scotland", GIH: "Gujarati Indians in Houston",
  GWD: "Gambian in Western Division", IBS: "Iberian populations in Spain", ITU: "Indian Telugu in the UK",
  JPT: "Japanese in Tokyo", KHV: "Kinh in Ho Chi Minh City", LWK: "Luhya in Webuye, Kenya", MSL: "Mende in Sierra Leone",
  MXL: "Mexican Ancestry in Los Angeles", PEL: "Peruvian in Lima", PJL: "Punjabi in Lahore", PUR: "Puerto Rican in Puerto Rico",
  STU: "Sri Lankan Tamil in the UK", TSI: "Toscani in Italia", YRI: "Yoruba in Ibadan, Nigeria",
};

const ids = (f) => readFileSync(resolve(inp, f), "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
const train = ids("train2003.txt");
const test = ids("test501.txt");
if (new Set(train).size !== train.length || new Set(test).size !== test.length) throw new Error("duplicate IDs in a split");
const overlap = train.filter((s) => test.includes(s));
if (overlap.length) throw new Error(`IDs in both splits: ${overlap.join(", ")}`);

const panelPath = join(run.input("3_audit_pop_and_relatives"), "population.panel");
const panelBuf = readFileSync(panelPath);
const panelSha = createHash("sha256").update(panelBuf).digest("hex");
const panelMd5 = createHash("md5").update(panelBuf).digest("base64");

// Provenance: the panel must be the object the cloud run staged (Step 6 input manifest) and
// the one the Step 3 audit hashed.
const panelChecks = [];
const manifest = readJsonIf(join(run.input("6_test_model"), "input_manifest.json"));
const stagedPanel = manifest?.staged_inputs?.panel;
if (stagedPanel?.metadata?.md5Hash) {
  if (stagedPanel.metadata.md5Hash !== panelMd5 || Number(stagedPanel.metadata.size) !== panelBuf.length) {
    throw new Error(`panel md5 ${panelMd5} (${panelBuf.length} B) != staged input ${stagedPanel.metadata.md5Hash} (${stagedPanel.metadata.size} B) in 6_test_model/input/${run.runId}/input_manifest.json`);
  }
  panelChecks.push(`6_test_model/input/${run.runId}/input_manifest.json`);
}
const audit = readJsonIf(join(run.results("3_audit_pop_and_relatives"), "audit_summary.json"));
if (audit?.population_panel_sha256) {
  if (audit.population_panel_sha256 !== panelSha) throw new Error(`panel sha256 ${panelSha} != audit_summary ${audit.population_panel_sha256}`);
  panelChecks.push(`3_audit_pop_and_relatives/results/${run.runId}/audit_summary.json`);
}
const training = readJsonIf(join(run.results("5_fit_pca_and_classifier"), "training_summary.json"));
if (training?.run_id && training.run_id !== run.runId) throw new Error(`training_summary.json is from run ${training.run_id}, expected ${run.runId}`);

const panel = new Map();
for (const line of panelBuf.toString("utf8").split(/\r?\n/).slice(1)) {
  const f = line.trim().split(/\s+/);
  if (f.length >= 3) panel.set(f[0], { pop: f[1], superPop: f[2], sex: f[3] || null });
}

const rows = [];
for (const [split, list] of [["train", train], ["test", test]]) {
  for (const id of list) {
    const p = panel.get(id);
    if (!p) throw new Error(`${id} (${split}) not in population panel`);
    rows.push({ sample: id, split, pop: p.pop, popName: POP_NAMES[p.pop] || null, superPop: p.superPop, sex: p.sex });
  }
}

// ---------------------------------------------------------------------------
// Step 6 evaluation of the published model (optional)
// ---------------------------------------------------------------------------

const GROUPS = ["AFR", "AMR", "EAS", "EUR", "SAS"];
const readTsv = (path) => {
  const lines = readFileSync(path, "utf8").split(/\r?\n/).filter((l) => l.trim());
  const header = lines[0].split("\t");
  return lines.slice(1).map((l) => Object.fromEntries(header.map((h, i) => [h, l.split("\t")[i]])));
};

/** Step 6 results folder of the run (cloud/6_test_model/results/<run_id>/), if it has predictions. */
function findStep6() {
  const dir = run.results("6_test_model");
  if (!existsSync(join(dir, "predictions.tsv"))) return null;
  const ts = readJsonIf(join(dir, "test_summary.json"));
  if (ts?.run_id && ts.run_id !== run.runId) throw new Error(`6_test_model/test_summary.json is from run ${ts.run_id}, expected ${run.runId}`);
  if (ts?.selected_markers && run.metadata?.feature_count && ts.selected_markers !== run.metadata.feature_count) {
    throw new Error(`6_test_model/test_summary.json has ${ts.selected_markers} markers, model/metadata.json has ${run.metadata.feature_count}`);
  }
  return { runId: run.runId, dir };
}

let evaluation = null;
const step6 = findStep6();
if (step6) {
  const preds = readTsv(join(step6.dir, "predictions.tsv"));
  const byId = new Map(rows.map((r) => [r.sample, r]));
  const testIds = new Set(rows.filter((r) => r.split === "test").map((r) => r.sample));
  if (preds.length !== testIds.size) throw new Error(`predictions.tsv has ${preds.length} rows, cohort has ${testIds.size} test people`);
  for (const p of preds) {
    const r = byId.get(p.IID);
    if (!r || r.split !== "test") throw new Error(`predictions.tsv: ${p.IID} is not a test person`);
    if (p.actual_group !== r.superPop) throw new Error(`predictions.tsv: ${p.IID} actual_group ${p.actual_group} != panel ${r.superPop}`);
    if (!GROUPS.includes(p.predicted_group)) throw new Error(`predictions.tsv: ${p.IID} unknown predicted_group ${p.predicted_group}`);
    r.predicted = p.predicted_group;
    r.probs = Object.fromEntries(GROUPS.map((g) => [g, Math.round(Number(p[`prob_${g}`]) * 1e4) / 1e4]));
    testIds.delete(p.IID);
  }
  if (testIds.size) throw new Error(`predictions.tsv is missing ${testIds.size} test people`);

  const readJson = (f) => readJsonIf(join(step6.dir, f));
  const ts = readJson("test_summary.json"), parity = readJson("onnx_parity.json");
  const testRows = rows.filter((r) => r.split === "test");
  const correct = testRows.filter((r) => r.predicted === r.superPop).length;
  if (ts && ts.correct !== correct) throw new Error(`test_summary.json says ${ts.correct} correct, predictions.tsv gives ${correct}`);
  const confusion = {};
  for (const r of testRows) (confusion[r.superPop] ??= {})[r.predicted] = ((confusion[r.superPop] ??= {})[r.predicted] || 0) + 1;

  evaluation = {
    runId: step6.runId,
    source: `cloud/6_test_model/results/${step6.runId}/`,
    people: testRows.length,
    correct,
    accuracy: ts?.accuracy ?? correct / testRows.length,
    balancedAccuracy: ts?.balanced_accuracy ?? null,
    selectedMarkers: ts?.selected_markers ?? null,
    confusion,
    misclassified: testRows.filter((r) => r.predicted !== r.superPop).map((r) => ({ sample: r.sample, pop: r.pop, known: r.superPop, predicted: r.predicted })),
    parity: parity ? {
      passed: parity.same_predicted_labels === true && parity.max_probability_absolute_difference <= parity.tolerance,
      rows: parity.people_compared,
      max_abs_proba_diff: parity.max_probability_absolute_difference,
      tolerance: parity.tolerance,
      runtime: parity.runtime,
    } : null,
    note: ts?.note ?? null,
  };
}

// The split used by this run was validated against an earlier audit run (Step 2 input manifest).
const baselineSplitRunId = manifest?.staged_inputs?.baseline_train?.original_uri?.match(/results\/([^/]+)\//)?.[1] ?? null;

const count = (filter) => rows.filter(filter).reduce((m, r) => { m[r.superPop] = (m[r.superPop] || 0) + 1; return m; }, {});
const summaryOut = {
  generatedAt: new Date().toISOString(),
  panel: { file: "integrated_call_samples_v3.20130502.ALL.panel", source: `cloud/3_audit_pop_and_relatives/input/${run.runId}/population.panel`, sha256: panelSha, verifiedAgainst: panelChecks },
  train: { n: train.length, byGroup: count((r) => r.split === "train") },
  test: { n: test.length, byGroup: count((r) => r.split === "test"), evaluation },
  trainingRun: {
    runId: run.runId,
    source: `cloud/5_fit_pca_and_classifier/results/${run.runId}/`,
    baselineSplitRunId,
    ...(training ? {
      selectedMarkers: training.selected_markers ?? null,
      bestParameters: training.best_parameters ?? null,
      cvAccuracy: training.cv_accuracy ?? null,
      cvBalancedAccuracy: training.cv_balanced_accuracy ?? null,
      sklearnVersion: training.sklearn_version ?? null,
    } : {}),
  },
};

writeFileSync(out, JSON.stringify({ summary: summaryOut, rows }));
console.log(`Wrote ${out}`);
console.log(JSON.stringify({ ...summaryOut, test: { ...summaryOut.test, evaluation: evaluation ? { ...evaluation, confusion: "…" } : null } }, null, 2));
if (!evaluation) console.log(`No Step 6 predictions under cloud/6_test_model/results/${run.runId}/ — test rows carry known labels only.`);
if (!training) console.log(`No cloud/5_fit_pca_and_classifier/results/${run.runId}/training_summary.json — trainingRun has provenance only (see cloud/README.md).`);
