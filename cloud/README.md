# cloud/ — local mirror of the pipeline bucket

`cloud/` mirrors `gs://all23_0710/ancestry/my23_v5_ancestry_model/`, the Cloud Run job that
builds, tests and applies the ancestry model. Paths are identical to the bucket, so a bucket URI
in any manifest (`_SUCCESS.json`, `input_manifest.json`, `summary.json`) maps to
`cloud/<same path>`. The build scripts in `scripts/` read from here for the run named in
`model/metadata.json` (`run_id`).

```
cloud/
├── source/<run_id>/                     pipeline source as deployed: pipeline.py, common.py, export_onnx.py,
│                                        deploy.sh, Dockerfile, config.json (effective) + config.template.json,
│                                        README.md (how to deploy and run), VALIDATION.md, browser/, tests/,
│                                        source_manifest.json (SHA-256 of every file)
├── <step>/source/<run_id>/step.py       the step's own code   (1_prepared_data also has prepare.js + the v5 position derivative)
├── <step>/input/<run_id>/               staged inputs + input_manifest.json (URIs, md5, size of every input)
├── <step>/results/<run_id>/             the step's outputs, closed by _SUCCESS.json
└── runs/<run_id>/                       model_ready.json (steps 1–6 finished) and pca_reference/ (separate export)
```

Steps: `1_prepared_data` · `2_split_the_samples` · `3_audit_pop_and_relatives` · `4_snp_qc_and_ld_prune` ·
`5_fit_pca_and_classifier` · `6_test_model` · `7_apply_v5_classifier`.

## Run `my23-20261028-154934` — what the results hold

| Where | What |
|-------|------|
| `2_split_the_samples/results/` | `train2003.keep`, `test501.keep`, `split_summary.json`; inputs `train2003.txt`, `test501.txt`, `split_validation.json` |
| `3_audit_pop_and_relatives/results/` | `population_counts.tsv`, `broad_group_counts.tsv`, `train2003_cv_groups.tsv`, `all_close_pairs.tsv`, `cross_split_pairs.tsv`, `related_test_ids.txt`, `audit_summary.json`; inputs `population.panel` (Phase 3 panel), `deg2_phase3.kin0` |
| `4_snp_qc_and_ld_prune/results/` | `marker_summary.json` (588,062 → 426,036 after QC → 335,663 after LD pruning); `chromosomes/chrN/` kept / removed / pruned lists and PLINK logs |
| `5_fit_pca_and_classifier/results/` | `training_summary.json` (10 PCs, C = 1.0; CV accuracy 0.997), `cv_scores.json`, `selected_markers.tsv`, `model.joblib`, `model_checksums.json` |
| `6_test_model/results/` | `predictions.tsv`, `confusion_matrix.tsv`, `by_actual_group.tsv`, `by_population.tsv`, `test_summary.json` (500 / 501), `onnx_parity.json` |
| `7_apply_v5_classifier/results/` | `summary.json` (74 files / 72 people, 0 skipped), `merge_audit.json`, `predictions.json`, `individuals/*.json`, `consolidated_participants.json` (catalog + predictions → `data/participants_catalog.json`), `v5_build37_table.csv`; inputs `participants.json`, `chip_match_results.json`, `test_files_manifest.json` |
| `runs/pca_reference/` | `train2003_pcs.tsv`, `test501_pcs.tsv`, `pca_summary.json` → `model/pca_reference.json` |

## What is not in git

The mirror on disk is complete (2 GB); `.gitignore` keeps these out of the repository:

| Excluded | Why | Size |
|----------|-----|------|
| `1_prepared_data/input/`, `1_prepared_data/results/` | `v5_manifest.json` (215 MB) exceeds GitHub's 100 MB file limit; prepared PLINK chromosomes are intermediates | 658 MB |
| `7_apply_v5_classifier/input/test/files/` | the 74 raw 23andMe files; would push the repo past the GitHub Pages size limit | 1.2 GB |
| `*/results/*/artifacts.zip` | re-pack of files already present next to it | 41 MB |
| `6_test_model/results/*/browser/`, `7_apply_v5_classifier/results/*/browser/` | the published bundle — served from `model/` and `vendor/`, verified identical | 37 MB ×2 |
| `runs/*/pca_reference/predictions.tsv` | copy of `6_test_model/results/*/predictions.tsv` | 64 KB |
| `**/my23-20261028-153511/` | aborted first attempt (only two staged inputs exist) | 215 MB |

## Mirroring a run

```bash
ROOT=gs://all23_0710/ancestry/my23_v5_ancestry_model
RUN=my23-20261028-154934
for step in 2_split_the_samples 3_audit_pop_and_relatives 4_snp_qc_and_ld_prune \
            5_fit_pca_and_classifier 6_test_model 7_apply_v5_classifier; do
  for kind in input results source; do
    gcloud storage cp -r "$ROOT/$step/$kind/$RUN" "cloud/$step/$kind/"
  done
done
gcloud storage cp -r "$ROOT/1_prepared_data/source/$RUN" cloud/1_prepared_data/source/
gcloud storage cp -r "$ROOT/source/$RUN" cloud/source/
gcloud storage cp -r "$ROOT/runs/$RUN"   cloud/runs/
# optional, local only (ignored by git): $ROOT/1_prepared_data/{input,results}/$RUN, $ROOT/7_apply_v5_classifier/input/test
```

Then regenerate the derived files:

```sh
npm run build:data      # build-catalog + build-cohort + build-pca-reference
```

`build-cohort.mjs` verifies the panel against the Step 6 `input_manifest.json` md5 and the Step 3
`audit_summary.json` SHA-256; `model_checksums.json` pins `model.joblib` and `selected_markers.tsv`,
and the same model SHA-256 appears in `test_summary.json`, `pca_summary.json` and Step 7 `summary.json`.
To redeploy the pipeline, zip `source/<run_id>/` together with each `<step>/source/<run_id>/` laid out
as `<step>/source/` and follow `source/<run_id>/README.md`.
