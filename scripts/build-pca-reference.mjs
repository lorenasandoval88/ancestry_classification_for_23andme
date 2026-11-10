// Build model/pca_reference.json (reference-people PC coordinates for the PCA tab) from the
// per-person PC score tables exported by the cloud run.
//
//   node scripts/build-pca-reference.mjs [--run <run_id>]
//   node scripts/build-pca-reference.mjs --train path/train2003_pcs.tsv --test path/test501_pcs.tsv \
//        [--predictions path/predictions.tsv] [--v5 path/v5_files_pcs.tsv] [--evr path/pca_summary.json] \
//        [--out model/pca_reference.json]
//   node scripts/build-pca-reference.mjs --pcs path/reference_pcs.tsv      # one table for both cohorts
//
// Without flags, files are discovered in the bucket mirror cloud/ for the run named in
// model/metadata.json: PC tables and pca_summary.json under runs/<run>/pca_reference/,
// predictions.tsv under 6_test_model/results/<run>/ (see cloud/README.md):
//   train2003_pcs.tsv   sample + PC1..PCk for the 2,003 training people
//   test501_pcs.tsv     sample + PC1..PCk for the 501 test people
//   reference_pcs.tsv   alternative: both cohorts in one table, with a split column (train/test)
//                       or no split column (assigned from data/reference_cohort.json)
//   predictions.tsv     Step 6  (optional) sample + predicted group (+ probabilities) for the 501
//   v5_files_pcs.tsv    Step 7  (optional) file/participant + PC1..PCk (+ predicted) for PGP v5 files
//   pca_summary.json    (optional) { pc_count, explained_variance_ratio: [...], run_id, marker_count }
//
// Column names are flexible: the ID column is sample/IID/id/participant/file (else the first column),
// PC columns are PC1..PCk, an optional predicted-group column is predicted_group/prediction/label.
//
// Known labels and populations come from data/reference_cohort.json; every ID in the PC tables
// must be in the cohort, and counts must match (2,003 / 501).
//
// Assignment weights: with model/model.onnx present, every reference person also gets
// predicted + probabilities = softmax(PC · classifier_weights + classifier_bias). The formula is
// first checked against the Step 6 predictions of the 501 test people (same group for all, max
// |Δp| ≤ 1e-3), then applied to the training people (in-sample) and any v5 table without a
// predicted column. Test people keep Step 6's recorded values.
//
// Cloud-side export (same fitted PCA for both splits — do not refit on the 501):
//
//   import joblib, json, pandas as pd
//   bundle = joblib.load("model.joblib")
//   pipe = bundle["pipeline"]                       # imputer -> scale -> pca -> classifier
//   pre = pipe[:-1]                                 # fitted preprocessing + PCA
//   # X_train / X_test: REF-allele dosages (0/1/2, NaN missing), columns in bundle["markers"] order
//   cols = [f"PC{i+1}" for i in range(pipe.named_steps["pca"].n_components_)]
//   pd.DataFrame(pre.transform(X_train), index=train_ids, columns=cols).rename_axis("sample").to_csv("train2003_pcs.tsv", sep="\t")
//   pd.DataFrame(pre.transform(X_test),  index=test_ids,  columns=cols).rename_axis("sample").to_csv("test501_pcs.tsv",  sep="\t")
//   pca = pipe.named_steps["pca"]
//   json.dump({"n_components": int(pca.n_components_), "explained_variance_ratio": pca.explained_variance_ratio_.tolist()},
//             open("pca_summary.json", "w"), indent=2)

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as onnxProto from "onnx-proto";
import { parseArgs, resolveRun } from "./lib/run-dir.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cohortPath = resolve(root, "data/reference_cohort.json");
const metadataPath = resolve(root, "model/metadata.json");
const modelPath = resolve(root, "model/model.onnx");

// Repo-relative path for messages/provenance; bare file name for files outside the repo.
const rel = (p) => { const r = relative(root, p); return r.startsWith("..") ? basename(p) : r.replace(/\\/g, "/"); };

const GROUPS = ["AFR", "AMR", "EAS", "EUR", "SAS"];
const ID_RE = /^(sample|sample_id|iid|id|participant|participant_id|person|person_id|file|file_name|filename)$/i;
// Only unambiguous prediction names; "group"/"label"/"reference_group" are known labels in the cloud exports.
const PRED_RE = /^(predicted|predicted_group|prediction|pred|pred_group|predicted_label)$/i;
const KNOWN_RE = /^(reference_group|actual_group|known_group|super_pop|superpop|true_group)$/i;

// ---------------------------------------------------------------------------

function findByName(name, dir) {
  if (!existsSync(dir)) return null;
  const hits = [];
  (function walk(d) {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (e.toLowerCase() === name.toLowerCase()) hits.push(p);
    }
  })(dir);
  if (hits.length > 1) throw new Error(`Several files named ${name} under ${relative(root, dir)}: ${hits.map((h) => relative(root, h)).join(", ")} — pass the one to use explicitly`);
  return hits[0] || null;
}

function readTsv(path) {
  const text = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("##"));
  if (lines.length < 2) throw new Error(`${rel(path)}: no data rows`);
  const sep = lines[0].includes("\t") ? "\t" : lines[0].includes(",") ? "," : /\s+/;
  const header = lines[0].replace(/^#/, "").split(sep).map((h) => h.trim());
  const rows = lines.slice(1).map((l, i) => {
    const f = l.split(sep).map((v) => v.trim());
    if (f.length !== header.length) throw new Error(`${rel(path)} line ${i + 2}: ${f.length} fields, header has ${header.length}`);
    return Object.fromEntries(header.map((h, j) => [h, f[j]]));
  });
  return { header, rows };
}

function pickIdColumn(header, path) {
  return header.find((h) => ID_RE.test(h)) ?? header[0];
}

function pcColumns(header, path) {
  const cols = header.filter((h) => /^PC\d+$/i.test(h)).sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)));
  if (!cols.length) throw new Error(`${rel(path)}: no PC1..PCk columns`);
  cols.forEach((c, i) => { if (Number(c.slice(2)) !== i + 1) throw new Error(`${rel(path)}: PC columns are not contiguous from PC1 (${cols.join(", ")})`); });
  return cols;
}

/** Read a PC table into { ids, scores, exact, predicted?, known? }; scores rounded to 4 dp, exact as written. */
function readScores(path) {
  const { header, rows } = readTsv(path);
  const idCol = pickIdColumn(header, path);
  const cols = pcColumns(header, path);
  const predCol = header.find((h) => PRED_RE.test(h)) || null;
  const knownCol = header.find((h) => KNOWN_RE.test(h)) || null;
  const ids = [], scores = [], exact = [], predicted = [], known = [];
  for (const r of rows) {
    const id = r[idCol];
    if (!id) throw new Error(`${rel(path)}: empty ID in column ${idCol}`);
    const full = cols.map((c) => {
      const v = Number(r[c]);
      if (!Number.isFinite(v)) throw new Error(`${rel(path)}: ${id} has non-numeric ${c} = ${JSON.stringify(r[c])}`);
      return v;
    });
    ids.push(id); exact.push(full); scores.push(full.map((v) => Math.round(v * 1e4) / 1e4));
    if (predCol) predicted.push(normGroup(r[predCol], path, id));
    if (knownCol) known.push(normGroup(r[knownCol], path, id));
  }
  if (new Set(ids).size !== ids.length) throw new Error(`${rel(path)}: duplicate IDs`);
  return { ids, scores, exact, predicted: predCol ? predicted : null, known: knownCol ? known : null, k: cols.length, idCol, predCol, knownCol };
}

/**
 * Classifier parameters of the published ONNX model (the logistic-regression layer after PCA):
 * weights[k][C] and bias[C] in the order of metadata.classes. null when the model is absent.
 */
function readClassifier(modelPath, classes) {
  if (!existsSync(modelPath)) return null;
  const onnx = onnxProto.onnx ?? onnxProto.default?.onnx ?? onnxProto.default ?? onnxProto;
  const g = onnx.ModelProto.decode(readFileSync(modelPath)).graph;
  const f32 = (name) => {
    const t = g.initializer.find((t) => t.name === name);
    if (!t) throw new Error(`${rel(modelPath)}: no initializer ${name}`);
    return { data: new Float32Array(Uint8Array.from(t.rawData).buffer), dims: t.dims.map(Number) };
  };
  const w = f32("classifier_weights"), b = f32("classifier_bias");
  if (w.dims.length !== 2 || w.dims[1] !== classes.length || b.dims[0] !== classes.length) {
    throw new Error(`${rel(modelPath)}: classifier_weights ${w.dims.join("x")} / classifier_bias ${b.dims.join("x")} do not match ${classes.length} classes`);
  }
  const weights = Array.from({ length: w.dims[0] }, (_, i) => Array.from(w.data.subarray(i * classes.length, (i + 1) * classes.length)));
  return { weights, bias: Array.from(b.data), k: w.dims[0] };
}

/** softmax(pc · W + b) → { group: probability } and the arg-max group. */
function assign(pcs, clf, classes) {
  const logits = clf.bias.map((b0, c) => b0 + pcs.reduce((s, v, i) => s + v * clf.weights[i][c], 0));
  const mx = Math.max(...logits);
  const ex = logits.map((l) => Math.exp(l - mx));
  const z = ex.reduce((a, b) => a + b, 0);
  const probs = Object.fromEntries(classes.map((g, c) => [g, Math.round((ex[c] / z) * 1e4) / 1e4]));
  return { probs, predicted: classes[logits.indexOf(mx)] };
}

function normGroup(v, path, id) {
  const g = String(v || "").trim().toUpperCase();
  if (!g || g === "NA" || g === "NONE" || g === "SKIPPED") return null;
  if (!GROUPS.includes(g)) throw new Error(`${rel(path)}: ${id} has unknown group ${JSON.stringify(v)}`);
  return g;
}

/** Step 6 predictions.tsv → Map(sample → { predicted, probs? }). */
function readPredictions(path) {
  const { header, rows } = readTsv(path);
  const idCol = pickIdColumn(header, path);
  const predCol = header.find((h) => PRED_RE.test(h));
  if (!predCol) throw new Error(`${rel(path)}: no predicted-group column (looked for ${PRED_RE})`);
  const probCols = GROUPS.map((g) => header.find((h) => new RegExp(`^(p|prob|proba|probability|p_|prob_|proba_|probability_)?_?${g}$`, "i").test(h)) || null);
  const m = new Map();
  for (const r of rows) {
    const probs = probCols.every(Boolean) ? Object.fromEntries(GROUPS.map((g, i) => [g, Math.round(Number(r[probCols[i]]) * 1e4) / 1e4])) : null;
    m.set(r[idCol], { predicted: normGroup(r[predCol], path, r[idCol]), probs });
  }
  return m;
}

function readEvr(path) {
  const text = readFileSync(path, "utf8");
  if (path.endsWith(".json")) {
    const j = JSON.parse(text);
    const evr = j.explained_variance_ratio ?? j.explained_variance_ratio_ ?? j.evr;
    if (!Array.isArray(evr)) throw new Error(`${rel(path)}: no explained_variance_ratio array`);
    return { evr: evr.map(Number), n: j.n_components ?? j.pc_count ?? evr.length, runId: j.run_id ?? null, markerCount: j.marker_count ?? j.feature_count ?? null };
  }
  const { header, rows } = readTsv(path);
  const col = header.find((h) => /explained_variance_ratio|evr|variance_ratio/i.test(h));
  if (!col) throw new Error(`${rel(path)}: no explained_variance_ratio column`);
  const evr = rows.map((r) => Number(r[col]));
  return { evr, n: evr.length };
}

// ---------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) {
  console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
  process.exit(0);
}

// Discovery roots in the bucket mirror, resolved only when a table is not given explicitly.
const needsRun = !(args.pcs || (args.train && args.test));
let run;
const found = (name, where = "pca") => {
  if (run === undefined) {
    try { run = resolveRun(root, args.run); }
    catch (e) { run = null; if (needsRun) throw e; }
  }
  if (!run) return null;
  const dir = where === "step6" ? run.results("6_test_model") : join(run.runDir, "pca_reference");
  return findByName(name, dir);
};

const trainPath = args.train ? resolve(args.train) : found("train2003_pcs.tsv");
const testPath = args.test ? resolve(args.test) : found("test501_pcs.tsv");
const combinedPath = args.pcs ? resolve(args.pcs) : (!trainPath && !testPath ? found("reference_pcs.tsv") : null);
const predPath = args.predictions ? resolve(args.predictions) : found("predictions.tsv", "step6");
const v5Path = args.v5 ? resolve(args.v5) : found("v5_files_pcs.tsv");
const evrPath = args.evr ? resolve(args.evr) : found("pca_summary.json");
const outPath = resolve(args.out || "model/pca_reference.json");

if (!combinedPath && (!trainPath || !testPath)) {
  const where = run ? `${rel(join(run.runDir, "pca_reference"))}/` : "cloud/runs/<run_id>/pca_reference/";
  console.error([
    "Could not find the PC score tables.",
    `  train: ${trainPath ? rel(trainPath) : `train2003_pcs.tsv not found under ${where} (or pass --train)`}`,
    `  test:  ${testPath ? rel(testPath) : `test501_pcs.tsv not found under ${where} (or pass --test)`}`,
    "  or one combined table with a split column: reference_pcs.tsv (or pass --pcs)",
    "Run with --help for the expected layout and the cloud-side export snippet.",
  ].join("\n"));
  process.exit(1);
}

const cohort = JSON.parse(readFileSync(cohortPath, "utf8"));
const byId = new Map(cohort.rows.map((r) => [r.sample, r]));
const expected = { train: cohort.summary.train.n, test: cohort.summary.test.n };

/** One table for both cohorts: rows are assigned by a split/cohort column, else by the cohort file. */
function splitCombined(path) {
  const { header } = readTsv(path);
  const all = readScores(path);
  const splitCol = header.find((h) => /^(split|cohort|set|subset|role)$/i.test(h)) || null;
  const rowsRaw = readTsv(path).rows;
  const idCol = all.idCol;
  const part = { train: { ids: [], scores: [], exact: [], predicted: all.predicted ? [] : null, known: all.known ? [] : null, k: all.k, idCol, predCol: all.predCol, knownCol: all.knownCol },
                 test: { ids: [], scores: [], exact: [], predicted: all.predicted ? [] : null, known: all.known ? [] : null, k: all.k, idCol, predCol: all.predCol, knownCol: all.knownCol } };
  all.ids.forEach((id, i) => {
    let s = splitCol ? String(rowsRaw[i][splitCol]).toLowerCase() : byId.get(id)?.split;
    if (s && /^train/.test(s)) s = "train"; else if (s && /^(test|heldout|held-out)/.test(s)) s = "test";
    if (s !== "train" && s !== "test") throw new Error(`${rel(path)}: cannot assign ${id} to train/test${splitCol ? ` (split = ${JSON.stringify(rowsRaw[i][splitCol])})` : " — not in reference_cohort.json"}`);
    part[s].ids.push(id); part[s].scores.push(all.scores[i]); part[s].exact.push(all.exact[i]);
    if (all.predicted) part[s].predicted.push(all.predicted[i]);
    if (all.known) part[s].known.push(all.known[i]);
  });
  return part;
}

const combined = combinedPath ? splitCombined(combinedPath) : null;
const train = combined ? combined.train : readScores(trainPath);
const test = combined ? combined.test : readScores(testPath);
const trainSrc = combinedPath || trainPath, testSrc = combinedPath || testPath;
if (train.k !== test.k) throw new Error(`train has ${train.k} PCs, test has ${test.k}`);
const k = train.k;

const preds = predPath ? readPredictions(predPath) : null;

function labelled(split, t, path) {
  const labels = [], pops = [];
  t.ids.forEach((id, i) => {
    const r = byId.get(id);
    if (!r) throw new Error(`${rel(path)}: ${id} is not in data/reference_cohort.json`);
    if (r.split !== split) throw new Error(`${rel(path)}: ${id} is a ${r.split} sample, not ${split}`);
    if (t.known && t.known[i] && t.known[i] !== r.superPop) throw new Error(`${rel(path)}: ${id} ${t.knownCol} = ${t.known[i]}, cohort panel says ${r.superPop}`);
    labels.push(r.superPop); pops.push(r.pop);
  });
  if (t.ids.length !== expected[split]) throw new Error(`${rel(path)}: ${t.ids.length} rows, cohort has ${expected[split]} ${split} people`);
  const missing = cohort.rows.filter((r) => r.split === split && !t.ids.includes(r.sample)).map((r) => r.sample);
  if (missing.length) throw new Error(`${rel(path)}: missing ${missing.length} ${split} people (${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", …" : ""})`);
  return { ids: t.ids, scores: t.scores, labels, pops };
}

const groups = { train: labelled("train", train, trainSrc), test: labelled("test", test, testSrc) };

// Test people: predicted labels from the table itself, else from Step 6 predictions.tsv.
let predicted = test.predicted;
let probs = null;
if (!predicted && preds) {
  predicted = test.ids.map((id) => {
    const p = preds.get(id);
    if (!p) throw new Error(`${rel(predPath)}: no prediction for test sample ${id}`);
    return p.predicted;
  });
  if ([...preds.values()].every((p) => p.probs)) probs = test.ids.map((id) => preds.get(id).probs);
}
if (predicted) {
  groups.test.predicted = predicted;
  if (probs) groups.test.probabilities = probs;
}

// Group-assignment weights for every reference person from the published classifier
// (softmax of the logistic layer applied to the PCs). The test people double as a check: the
// formula must reproduce Step 6's recorded predictions, which were computed from genotypes.
const meta = existsSync(metadataPath) ? JSON.parse(readFileSync(metadataPath, "utf8")) : {};
const classes = meta.classes || GROUPS;
const clf = readClassifier(modelPath, classes);
let weightsCheck = null;
if (clf) {
  if (clf.k !== k) throw new Error(`${rel(modelPath)} classifier takes ${clf.k} PCs, tables have ${k}`);
  const testAssigned = test.exact.map((pcs) => assign(pcs, clf, classes));
  if (groups.test.predicted) {
    const disagree = testAssigned.map((a, i) => (a.predicted !== groups.test.predicted[i] ? test.ids[i] : null)).filter(Boolean);
    if (disagree.length) throw new Error(`softmax(PC · W + b) assigns a different group than Step 6 for ${disagree.length} test people (${disagree.slice(0, 5).join(", ")}) — PC tables and model.onnx are not from the same fit`);
  }
  let maxDiff = 0;
  if (groups.test.probabilities) {
    testAssigned.forEach((a, i) => { for (const g of classes) maxDiff = Math.max(maxDiff, Math.abs(a.probs[g] - (groups.test.probabilities[i][g] ?? 0))); });
    if (maxDiff > 1e-3) throw new Error(`softmax(PC · W + b) differs from Step 6 probabilities by up to ${maxDiff} for the test people`);
  }
  weightsCheck = { test_people: test.ids.length, same_assigned_group: true, max_probability_absolute_difference: maxDiff };
  const trainAssigned = train.exact.map((pcs) => assign(pcs, clf, classes));
  groups.train.predicted = trainAssigned.map((a) => a.predicted);
  groups.train.probabilities = trainAssigned.map((a) => a.probs);
}

if (v5Path) {
  const v5 = readScores(v5Path);
  if (v5.k !== k) throw new Error(`${rel(v5Path)}: ${v5.k} PCs, reference has ${k}`);
  groups.v5_files = { ids: v5.ids, scores: v5.scores };
  if (v5.predicted) groups.v5_files.predicted = v5.predicted;
  else if (clf) {
    const a = v5.exact.map((pcs) => assign(pcs, clf, classes));
    groups.v5_files.predicted = a.map((x) => x.predicted);
    groups.v5_files.probabilities = a.map((x) => x.probs);
  }
}

let evr = null, evrInfo = null;
if (evrPath) {
  const e = readEvr(evrPath);
  if (e.evr.length < k) throw new Error(`${rel(evrPath)}: ${e.evr.length} variance ratios, tables have ${k} PCs`);
  evr = e.evr.slice(0, k).map((v) => Math.round(v * 1e6) / 1e6);
  evrInfo = e;
}

// The coordinates must come from the same training run as the published ONNX bundle.
if (evrInfo?.runId && meta.run_id && evrInfo.runId !== meta.run_id) {
  throw new Error(`${rel(evrPath)} is from run ${evrInfo.runId}, but model/metadata.json is run ${meta.run_id}`);
}
if (evrInfo?.markerCount && meta.feature_count && evrInfo.markerCount !== meta.feature_count) {
  throw new Error(`${rel(evrPath)} says ${evrInfo.markerCount} markers, model/metadata.json says ${meta.feature_count}`);
}

const out = {
  generated_at: new Date().toISOString(),
  run_id: meta.run_id ?? null,
  model_sha256: meta.model_sha256 ?? null,
  n_components: k,
  classes,
  explained_variance_ratio: evr,
  sources: Object.fromEntries(Object.entries({ train: trainSrc, test: testSrc, predictions: predPath, v5_files: v5Path, explained_variance: evrPath, classifier: clf ? modelPath : null })
    .filter(([, p]) => p).map(([key, p]) => [key, rel(p)])),
  assignment_weights: clf ? {
    method: "softmax(PC · classifier_weights + classifier_bias) from model.onnx; test people carry Step 6's recorded probabilities, training people are in-sample",
    check_against_step6: weightsCheck,
  } : null,
  groups,
};

writeFileSync(outPath, JSON.stringify(out));

const testAcc = predicted ? groups.test.labels.filter((l, i) => l === predicted[i]).length : null;
const trainAcc = groups.train.predicted ? groups.train.labels.filter((l, i) => l === groups.train.predicted[i]).length : null;
console.log(`Wrote ${rel(outPath)} (${(statSync(outPath).size / 1024).toFixed(0)} KB)`);
console.log(`  components: ${k}${evr ? ` · PC1–${k} explain ${(evr.reduce((a, b) => a + b, 0) * 100).toFixed(1)}% of variance` : " · no explained_variance_ratio (pass --evr pca_summary.json)"}`);
console.log(`  train: ${groups.train.ids.length} people · test: ${groups.test.ids.length} people${predicted ? ` · test predicted correct: ${testAcc}/${predicted.length}` : " · test predictions: none (pass --predictions)"}`);
if (groups.v5_files) console.log(`  v5 files: ${groups.v5_files.ids.length}`);
if (weightsCheck) console.log(`  assignment weights: softmax(PC·W+b) agrees with Step 6 on all ${weightsCheck.test_people} test people (max |Δp| ${weightsCheck.max_probability_absolute_difference.toExponential(1)}) · train in-sample correct: ${trainAcc}/${groups.train.ids.length}`);
else console.log("  assignment weights: model/model.onnx not found — train/v5 rows carry PCs only");
