// Build a slim, de-identified participant catalog for the web app from the PGP participant /
// file catalog (one row per 23andMe file).
//
//   node scripts/build-catalog.mjs [--run <run_id>]
//   node scripts/build-catalog.mjs --input path/participants.json [--chip path/chip_match_results.json]
//
// Input: the Step 7 outputs of the published run in the bucket mirror cloud/ (see cloud/README.md):
//   7_apply_v5_classifier/results/<run>/consolidated_participants.json   885 participants / 1,018 files + predictions
//   7_apply_v5_classifier/input/<run>/chip_match_results.json            chip report Step 7 consumed: parsed variant
//                                                                        rows, unique coordinates, chip match rates
// --input / --chip override either path (an older snapshot with chipClassificationResult inline also works).
// Output: data/participants_catalog.json
// Excluded on purpose: real_name, zip, and the storage-host finalUrl.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, resolveRun } from "./lib/run-dir.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const run = args.input && args.chip ? null : resolveRun(root, args.run);
const src = args.input ? resolve(root, args.input) : join(run.results("7_apply_v5_classifier"), "consolidated_participants.json");
const chipPath = args.chip ? resolve(root, args.chip) : join(run.input("7_apply_v5_classifier"), "chip_match_results.json");

if (!existsSync(src)) {
  console.error(`Input not found: ${relative(root, src)}\nFetch the Step 7 results into cloud/ (see cloud/README.md) or pass --input <path>.`);
  process.exit(1);
}
console.log(`Reading ${relative(root, src)}`);
const participants = JSON.parse(readFileSync(src, "utf8"));

// Chip report keyed by storage object name (matches genomeBuildFiles[0].gcsPath).
const chipByObject = new Map();
if (existsSync(chipPath)) {
  for (const r of JSON.parse(readFileSync(chipPath, "utf8"))) chipByObject.set(r.objectName, r);
  console.log(`Chip report ${relative(root, chipPath)}: ${chipByObject.size} files`);
} else if (args.chip) {
  console.error(`Chip report not found: ${relative(root, chipPath)}`);
  process.exit(1);
}

const out = resolve(root, "data/participants_catalog.json");
const GROUPS = ["AFR", "AMR", "EAS", "EUR", "SAS"];

const survey = (p, re) => {
  const rows = p.profile?.google_survey_results?.[0];
  if (!Array.isArray(rows)) return null;
  const hit = rows.find(([q]) => re.test(String(q)));
  const v = hit?.[1]?.trim();
  return v && v !== "No response" ? v : null;
};

const rows = [];
for (const p of participants) {
  const self = {
    sex: survey(p, /^(sex\/gender|anatomical sex at birth|what is your gender)/i),
    race: survey(p, /^race\/ethnicity$|^what is your race/i),
    ethnicity: survey(p, /^what is your ethnicity/i),
    birthYear: survey(p, /^year of birth$/i),
    state: p.profile?.state || null,
  };
  for (const f of p.files || []) {
    const gb = f.genomeBuildFiles?.[0];
    const ccr = f.chipClassificationResult ?? (gb?.gcsPath ? chipByObject.get(gb.gcsPath) : null) ?? null;
    const build = f.genomeBuild ?? ccr?.genomeBuild ?? null;
    const a = f.ancestryClassification;
    // Step 7 (published run) nests coverage under qc and names the run run_id; the earlier
    // snapshot had them flat as called_fraction / prediction_run_id.
    const probs = a?.reference_group_probabilities;
    rows.push({
      participantId: p.id,
      profileUrl: p.profileUrl,
      fileName: f.filename || f.name || null,
      publishedDate: f.publishedDate || null,
      sizeMB: gb?.sizeMB ?? null,
      downloadUrl: f.downloadUrl || null,
      valid23File: !!f.valid23File,
      genomeBuild: build ? `GRCh${build}` : null,
      chip: f.chipClassification || null,
      chipSource: f.chipVersionSource || null,
      chipMatch: f.chipMatchPercentages || null,
      variantRows: ccr?.parsedVariantRows ?? null,
      uniqueCoords: ccr?.totalUniqueCoordinates ?? null,
      processingNote: f.processingNote || null,
      ancestry: a?.status === "classified" ? {
        group: a.predicted_group,
        calledFraction: a.qc?.called_fraction ?? a.called_fraction ?? null,
        calledMarkers: a.qc?.called_model_markers ?? a.called_model_markers ?? null,
        modelMarkers: a.model_markers ?? null,
        model: a.model ?? null,
        runId: a.run_id ?? a.prediction_run_id ?? null,
        ...(probs ? { probs: Object.fromEntries(GROUPS.map((g) => [g, Math.round(Number(probs[g]) * 1e4) / 1e4])) } : {}),
      } : null,
      self,
    });
  }
}

const summary = {
  generatedAt: new Date().toISOString(),
  participants: participants.length,
  files: rows.length,
  valid23Files: rows.filter((r) => r.valid23File).length,
  classified: rows.filter((r) => r.ancestry).length,
  byGroup: rows.reduce((m, r) => { if (r.ancestry) m[r.ancestry.group] = (m[r.ancestry.group] || 0) + 1; return m; }, {}),
};

writeFileSync(out, JSON.stringify({ summary, rows }));
console.log(`Wrote ${out}`);
console.log(summary);
