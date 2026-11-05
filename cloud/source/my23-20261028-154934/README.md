# my23_v5_ancestry_model

Rebuild one 23andMe v5 ancestry classifier from 1000 Genomes Phase 3 GRCh37.
Use the original **2,003 training people and 501 test people**. Apply standard
training-only SNP QC and LD pruning. There are no special marker-panel rules.
Keep all 2,003 training people; report the known cross-split relatives.

## 1. Put the package in Cloud Shell

Upload the ZIP, then run (adjust the ZIP's location if necessary):

```bash
df -h ~
mkdir -p ~/ancestry
unzip -n ~/my23_v5_ancestry_model.zip -d ~/ancestry
cd ~/ancestry/my23_v5_ancestry_model
```

Cloud Shell only runs `bash`, `gcloud`, and Python 3 standard-library staging.
You do **not** need Node, npm, scikit-learn, ONNX, or the genotype datasets
installed in Cloud Shell. Dependencies are installed by Cloud Build. The package
is about 6 MB; it contains code plus a compact v5 position manifest, no personal
profiles or raw genotypes. Do not download the full reference into your home disk.
If home is full, extract under `/tmp/ancestry` instead; that directory is temporary,
so retain the uploaded ZIP and bucket source snapshots.

## 2. Check the existing inputs

These defaults are in `config.json`:

| Input | Existing location |
|---|---|
| Full chromosome reference | `gs://ref1000g/phase3/` |
| v5 manifest | `gs://ref1000g/ancestry/1_prepared_data/input/v5_manifest.json` |
| Original training IDs | `gs://ref1000g/ancestry/1_prepared_data/input/train2003.txt` |
| Original test IDs | `gs://ref1000g/ancestry/1_prepared_data/input/test501.txt` |
| Population labels | `gs://ref1000g/phase3/integrated_call_samples_v3.20130502.ALL.panel` |
| Published relative pairs | `gs://ref1000g/ancestry/relatives/input/deg2_phase3.kin0` |
| NEW participants | `gs://all23_0710/updatedParticipantsList/NEW_participants_1020_consolidated_with_build_and_profile_07102026_2053.json` |
| Chip report | `gs://all23_0710/chip_manifests/chip_match_results/chip_match_results.json` |
| Personal genotype files | `gs://all23_0710/geneticFiles/` |

The exact NEW-participant object filename was inferred from the screenshot;
it has **not** been checked live. Confirm it before deployment:

```bash
gcloud storage ls 'gs://all23_0710/updatedParticipantsList/NEW*'
```

If the displayed object name differs, set the exact URI before deployment:

```bash
export PARTICIPANTS_URI='gs://all23_0710/updatedParticipantsList/EXACT_NEW_FILENAME.json'
```

The package checks for 885 participants, 1,018 file records, and agreement between
the consolidated JSON and chip report on exactly 74 build-37 v5 files. The supplied
attachments were checked locally: all 74 have unique stored GCS paths and belong
to 72 people. No chip classification is rerun. Original chip fields are preserved.

## 3. Build and deploy

```bash
cd ~/ancestry/my23_v5_ancestry_model
bash deploy.sh
```

Defaults:

- Project: `nih-nci-dceg-episphere-dev`
- Region: `us-east4`
- Job: `my23-v5-ancestry-model`
- Artifact repository: `phase3-download` (created if missing)
- Runtime account: `phase3-reference-download@nih-nci-dceg-episphere-dev.iam.gserviceaccount.com`
- Output: `gs://all23_0710/ancestry/my23_v5_ancestry_model/`
- One task, 8 vCPU, 32 GiB, 24-hour timeout, no automatic retries.

`deploy.sh` enables APIs, grants the existing runtime account bucket-level
Object Viewer/Object Creator on `all23_0710` and Object Viewer on `ref1000g`,
stages input snapshots and source, builds an image, and deploys it. It does not
start an execution. It uses **Cloud Build -> --image** deployment, not --source.
It does not change project IAM or create/download private service-account keys.

If bucket bindings already exist and your login cannot change bucket policies,
run `SETUP_BUCKET_IAM=0 bash deploy.sh`. This skips bindings; it does not bypass
missing permissions. A bucket administrator must grant them if they are absent.
The deployer also needs normal Cloud Build, Artifact Registry, Cloud Run, and
permission to use the runtime account. No script can eliminate organizational
IAM restrictions. Keep the bucket's participant and prediction objects private;
this script does not alter bucket access mode or set object ACLs.

Training/test IDs are compared by membership against the completed Step 3 lists
in `20261026-164720-2308`. Headers, line endings, FID columns, and row order may
differ; the exact 2,003/501 people must match, with no duplicates or overlap.
Both input-file byte checksums and normalized membership checksums are recorded
in `2_split_the_samples/input/RUN_ID/split_validation.json`. Original files are
not edited. The manifest and published related-pair report still have exact
expected-byte checksums. Update `baseline_split` only when intentionally choosing
a different, reviewed split.

The generated `.deployment/run.env` records the exact run/configuration. Each
run is immutable. For a later, fresh rebuild, rerun `bash deploy.sh` with a new
RUN_ID; use a new RUN_ID after code/input/settings changes. If the original package
stopped at its early training-file checksum check, reuse that failed RUN_ID after
applying the fix: no source/configuration or model was deployed yet.

## 4. Start all seven steps

```bash
gcloud run jobs execute my23-v5-ancestry-model \
  --project=nih-nci-dceg-episphere-dev \
  --region=us-east4 --args=all --async
```

Or run training/testing first:

```bash
gcloud run jobs execute my23-v5-ancestry-model \
  --project=nih-nci-dceg-episphere-dev \
  --region=us-east4 --args=train --async
```

After that execution succeeds, apply the model:

```bash
gcloud run jobs execute my23-v5-ancestry-model \
  --project=nih-nci-dceg-episphere-dev \
  --region=us-east4 --args=apply --async
```

Cloud Shell may close after execution starts. Do not launch overlapping executions
for the same RUN_ID. To resume after failure/timeout, execute the **same deployed
job** with `--args=all`; do not redeploy with a new timestamp. Completed steps and
completed extraction/QC chromosomes are checked and skipped. Model fitting itself
is not checkpointed mid-fit. Completed fit/test artifacts are saved as atomic
archives before their individual files are published, so a failed publication can
resume without refitting. Step 7 verifies and reuses saved individual predictions.
Nothing is silently overwritten.

To run one step after prerequisites have completed, use `--args=step,4` (replace
4 with the required step). The unchanged 24-hour deadline applies to each execution;
if needed, finish in separate step executions. Execution is not guaranteed to
finish in a fixed time or cost. Jobs are billed while running.

## 5. The seven steps

| Step | What happens |
|---|---|
| 1 | Verify the original manifest SHA-256, then use its embedded compact derivative of 601,871 autosomal GRCh37 positions. Extract biallelic A/C/G/T SNP records and store one all-2,504-person PLINK dataset per chromosome. |
| 2 | Verify all chromosome sample headers against the original 2,003/501 lists; write normalized keep files without duplicating genotypes. |
| 3 | Count populations, check the published Phase 3 relative-pair report, keep all 2,003 training people, and group known training relatives for CV. This does not recompute genome-wide kinship. |
| 4 | On training people only: remove SNPs with missing fraction >0.02 or MAF <0.01; LD prune using a 200 kb window and r²=0.5. Treat every SNP alike. Save final SNP lists and counts. |
| 5 | Three-fold grouped CV compares 10/20 PCs and logistic C=0.1/1.0, using balanced accuracy then accuracy. Refit mean imputation, scaling, PCA, and classifier on all 2,003 training people. |
| 6 | Evaluate the frozen model on all 501 test people. Export the complete fitted numeric pipeline to ONNX. Require identical labels and absolute probability differences <=0.0001 between Python and ONNX. |
| 7 | Copy the 74 personal v5 files once, classify with ONNX and cross-check Python, merge fresh predictions into all 885 participant records, write table CSV and browser assets. |

Starting/final SNP counts are measured, not hardcoded to the previous model's
335,632 markers. QC/pruning is a new single-model run. The CV report explicitly
notes that full-training-cohort SNP QC/LD preceded CV, so CV is not a completely
nested marker-selection estimate. Test samples never enter QC, PCA fitting,
imputation-mean estimation, or classifier tuning. Because these 501 samples have
already been examined in earlier work, this is a rerun benchmark rather than
a new external validation. Known cross-split relatives remain by user choice.

## 6. Folder layout

All paths below start at `gs://all23_0710/ancestry/my23_v5_ancestry_model/`.
Every numbered step has `input/RUN_ID/`, `source/RUN_ID/`, `results/RUN_ID/`.
Later input folders contain URI manifests rather than duplicate genotypes.

| Path | Contents |
|---|---|
| `source/RUN_ID/` | Common controller, deployment files, effective config, code checksums. |
| `1_prepared_data/results/RUN_ID/chromosomes/chrN/` | `chrN.pgen`, `chrN.pvar.zst`, `chrN.psam`, `variant_map.tsv.gz`, summary and checkpoint. |
| `2_split_the_samples/results/RUN_ID/` | `train2003.keep`, `test501.keep`, split summary. |
| `3_audit_pop_and_relatives/results/RUN_ID/` | Population tables, related pairs, CV groups, audit summary. |
| `4_snp_qc_and_ld_prune/results/RUN_ID/` | Per-chromosome selected SNP lists, removed SNPs, PLINK logs and marker summary. |
| `5_fit_pca_and_classifier/results/RUN_ID/` | `model.joblib`, ordered `selected_markers.tsv`, CV scores, training summary, checksums. |
| `6_test_model/results/RUN_ID/` | Test predictions, confusion/per-group tables, test summary, ONNX parity report and ONNX assets. |
| `7_apply_v5_classifier/input/test/files/` | One-time copies of the 74 raw files. |
| `7_apply_v5_classifier/input/RUN_ID/` | Participants/chip snapshots, source references, raw-file copy manifest. |
| `7_apply_v5_classifier/results/RUN_ID/` | Individual reports, `predictions.json`, `consolidated_participants.json`, `v5_build37_table.csv`, `merge_audit.json`, summary. |
| `7_apply_v5_classifier/results/RUN_ID/browser/` | ONNX model, ordered markers, metadata, JavaScript classifier, preview page and pinned WASM runtime. |
| `runs/RUN_ID/model_ready.json` | Indicates steps 1-6 have finished. |

Each step writes `_SUCCESS.json` last, with configuration and output object
identities. A full preparation has an additional `_PREPARED.json`. The 74 personal
files are a different application batch from the 501 reference test samples.
Self-reported race/ethnicity remains separate from the predicted reference group.
All profiles are preserved, and disagreeing files for one person are flagged
instead of silently choosing one prediction. Earlier ancestry fields, if present,
are archived as history before new fields are added.

## 7. Monitor and use the browser release

```bash
gcloud run jobs executions list --job=my23-v5-ancestry-model \
  --project=nih-nci-dceg-episphere-dev --region=us-east4

gcloud run jobs logs read my23-v5-ancestry-model \
  --project=nih-nci-dceg-episphere-dev --region=us-east4 --limit=100
```

Source `.deployment/run.env` if you need the exact run ID again. To check the final
result (after deployment has created that file):

```bash
source .deployment/run.env
gcloud storage cat "${OUTPUT_ROOT}/7_apply_v5_classifier/results/${RUN_ID}/summary.json"
gcloud storage ls "${OUTPUT_ROOT}/7_apply_v5_classifier/results/${RUN_ID}/_SUCCESS.json"
```

Download only the Step 7 `browser/` folder for the website, not raw files, profiles,
identifiable predictions, or model.joblib. Serve it over HTTP(S). Its JavaScript
reads one or more new **known v5, build-37** text files locally and calls ONNX
Runtime Web. The 90% coverage / 1% allele-mismatch gates are reporting rules, not
validated accuracy guarantees. The saved graph fills missing values with training
means. No silent strand complement is applied.

Before publishing, compare at least one identical file in the cloud batch and the
actual browser, including group, probabilities, coverage, and duplicate handling.
The exported class labels are AFR/AMR/EAS/EUR/SAS reference groups. AMR represents
admixed American reference populations. Probabilities are not ancestry mixture
percentages, self-reported race/ethnicity, or clinical risk.

## Validation and limits

Local checks cover syntax, source parsers/manifest integrity, REF dosage ordering,
duplicate/no-call/allele handling, related-group CV, participant joins/conflict
handling, dry-run routing, and browser-parser logic. See `VALIDATION.md` for the
actual local results. The Docker build also runs a synthetic ONNX comparison and
checks required runtime files. This package has **not** been deployed to your
project, and the complete reference pipeline has not run from this workspace.
A successful cloud build is a required next gate, not proof of an end-to-end run.

Notebook: https://observablehq.com/@lorenasandoval88/23and-me-ancestry-inference

References: https://www.cog-genomics.org/plink/2.0/ld ;
https://www.cog-genomics.org/plink/2.0/resources ;
https://scikit-learn.org/stable/model_persistence.html ;
https://onnxruntime.ai/docs/tutorials/web/build-web-app.html ;
https://docs.cloud.google.com/sdk/gcloud/reference/run/jobs/execute
