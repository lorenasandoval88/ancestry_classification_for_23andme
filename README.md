# ancestry_classification_for_v5_23andme_files

**Live app:** https://lorenasandoval88.github.io/ancestry_classification_for_v5_23andme_files/

An **SDK (npm package) and web app** for classifying 23andMe raw-data files into a genetic
ancestry reference group. Upload or pass in a 23andMe v5 export and the classifier returns
the 1000 Genomes super-population that is genetically most similar to the profile:
**AFR, AMR, EAS, EUR, or SAS**, along with the classifier scores for each group.

The same model can be used two ways:

- **npm package (SDK)** – import the classifier into your own JavaScript/TypeScript project
  (Node.js or browser) and classify files programmatically.
- **Web app** – a browser-based interface where a user selects a 23andMe file and gets the
  reference-group prediction. Inference runs entirely in the browser; the genotype file is
  never uploaded to a server.

## Repository layout

Four kinds of content, each with one home: the **site** (`index.html`, `src/`, `model/`, `vendor/`,
`data/`), the **build scripts** that derive the generated files (`scripts/`), the **cloud pipeline**
mirrored verbatim from its bucket (`cloud/`), and **docs**. `<run>` = `my23-20261028-154934`, the
run named in `model/metadata.json`.

```
ancestry_classification_for_v5_23andme_files/
│
├── index.html                          web app (tabs: Upload & Classify · Participants · Inspect Genotypes · PCA)
├── src/
│   ├── app/app.js                      web-app logic
│   ├── css/style.css
│   └── sdk/                            npm package: index.js · classifier.js · parse23andme.js
│
├── model/                              published browser bundle — Step 6 export of <run>
│   ├── model.onnx                      imputer → scaler → PCA(10) → logistic → softmax
│   ├── markers.json                    335,663 markers (chrom, pos, ref, alt) in model column order
│   ├── metadata.json                   classes · coverage rules · SHA-256 of model/markers · run_id
│   └── pca_reference.json              reference people's PC1–10 for the PCA tab           (generated)
├── vendor/onnxruntime-web/             pinned ONNX Runtime Web 1.22.0 (WASM build, no CDN)
│
├── data/                               what the site fetches at runtime
│   ├── demo_genotype_file/genome_23.txt    real anonymised v5 export behind "Try a demo file"
│   ├── participants_catalog.json           PGP participants · files · predictions             (generated)
│   └── reference_cohort.json               2,504 1000 Genomes people · labels · test evaluation  (generated)
│
├── scripts/                            Node — regenerate the three (generated) files from cloud/
│   ├── build-catalog.mjs               7_apply results + chip report        → data/participants_catalog.json
│   ├── build-cohort.mjs                split lists · panel · audit · Step 6 → data/reference_cohort.json
│   ├── build-pca-reference.mjs         runs/<run>/pca_reference + Step 6    → model/pca_reference.json
│   └── lib/run-dir.mjs                 resolves cloud/<step>/{input,results,source}/<run>/
│
├── cloud/                              mirror of gs://all23_0710/ancestry/my23_v5_ancestry_model/  → cloud/README.md
│   ├── source/<run>/                   pipeline as deployed: pipeline.py · step runner · export_onnx.py · deploy.sh ·
│   │                                   Dockerfile · config · README (how to deploy) · VALIDATION · browser/ · tests/
│   ├── 1_prepared_data/                source/<run>/ prepare.js + v5 positions          ⊘ input/ results/ (658 MB)
│   ├── 2_split_the_samples/            input: train2003.txt · test501.txt   results: .keep lists · split_summary
│   ├── 3_audit_pop_and_relatives/      input: population.panel · kin0       results: population_counts · relatives · audit_summary
│   ├── 4_snp_qc_and_ld_prune/          results: marker_summary.json · chromosomes/chrN/ (kept / removed / pruned · PLINK logs)
│   ├── 5_fit_pca_and_classifier/       results: training_summary · cv_scores · selected_markers.tsv · model.joblib · checksums
│   ├── 6_test_model/                   results: predictions · confusion_matrix · test_summary · onnx_parity   ⊘ browser/ (= model/)
│   ├── 7_apply_v5_classifier/          input: participants.json · chip_match_results.json      ⊘ input/test/files/ (74 raw files, 1.2 GB)
│   │                                   results: summary · merge_audit · predictions.json · individuals/ · consolidated_participants.json
│   └── runs/<run>/                     model_ready.json · pca_reference/ (train2003_pcs · test501_pcs · pca_summary)
│
├── docs/                               23andMe_v5_single_model_pipeline_steps_1_to_7.docx — workflow plan
└── package.json · LICENSE · .gitignore · .gitattributes
```

Every `<step>/` also has `source/<run>/step.py` (that step's code) and `input/<run>/input_manifest.json`
(URI, md5 and size of every staged input). `⊘` marks bucket content present in a local mirror but
excluded from git for size or because it duplicates `model/`/`vendor/` — the full list is in
[`cloud/README.md`](./cloud/README.md).

| I want to… | Look in |
|------------|---------|
| classify a file from my own code | `src/sdk/` — see *Installation (SDK)* |
| change the page or its styling | `index.html`, `src/app/`, `src/css/` |
| know what the model is and how it was validated | `model/metadata.json`, `cloud/5_fit_pca_and_classifier/results/<run>/training_summary.json`, `cloud/6_test_model/results/<run>/test_summary.json` |
| see a step's exact inputs, outputs and code | `cloud/<step>/{input,results,source}/<run>/` |
| regenerate the catalog / cohort / PCA reference | `scripts/` → `npm run build:data` |
| redeploy or rerun the pipeline | `cloud/source/<run>/README.md` |

## What the classifier does

| Step | Action for a 23andMe file |
|------|---------------------------|
| Validate | Confirm a supported chip (23andMe v5) and genome build (GRCh37); record missing calls and incompatible alleles |
| Encode | Align the file to the model's fixed marker panel (`chr:pos:ref:alt`, GRCh37) and count the **REF allele** at each: 0, 1 or 2 — the same encoding as PLINK `--export A` used in training. Markers that are absent, no-call, allele-incompatible or conflicting duplicates become `NaN` |
| Coverage check | Require ≥ 90 % of model markers called and ≤ 1 % incompatible alleles among matched coordinates (rules come from `metadata.json`); otherwise return a reason instead of a group |
| Classify | Run the exported ONNX graph in the browser with `onnxruntime-web`: mean-fill `NaN` → scale → PCA → logistic regression → softmax. Imputation happens **inside the graph** with the fitted training means |
| Report | Return the AFR / AMR / EAS / EUR / SAS assignment, per-group probabilities, **PC scores**, marker coverage (called / missing / incompatible counts) and model version / checksum as separate fields |

New files never trigger retraining. Every stage uses a frozen marker order, allele coding,
preprocessing parameters, and model version.

## Model summary

| Resource | Status |
|----------|--------|
| Reference data | 1000 Genomes Phase 3 (2,504 people, 26 populations), restricted to 23andMe v5 positions on chromosomes 1–22, GRCh37 |
| Training cohort | 2,003 people (AFR 524 · AMR 272 · EAS 400 · EUR 408 · SAS 399) |
| Held-out test cohort | 501 people (AFR 137 · AMR 75 · EAS 104 · EUR 95 · SAS 90) |
| Relatedness audit | 15 published close-relative pairs were found among the training/test people |
| Ancestry model inputs | 335,663 markers in the published browser bundle (selected using training people only); 10 principal components; logistic regression C = 1.0 — run `my23-20261028-154934`, whose bucket is mirrored under [`cloud/`](./cloud/README.md) |
| Training-only cross-validation | 3-fold, balanced accuracy 0.995, accuracy 0.996 |
| Test accuracy | 500 of 501 reference labels correct |
| Personal-file application | 74 files from 72 participants (23andMe v5) |

### How the model was built (steps 1–7)

The reference model is produced by a seven-step cloud workflow run on Cloud Run against
`gs://all23_0710/ancestry/my23_v5_ancestry_model/`; that bucket — source, inputs and results of
every step — is mirrored in [`cloud/`](./cloud/README.md). Steps 1–6 run once to build and test
the model, step 7 applies the frozen model to personal files. Nothing in step 7 (or in this web
app) retrains or re-selects markers.

| Step | What it does | Saved result |
|------|--------------|--------------|
| 1 Prepare reference genotypes | Read the Phase 3 reference files, match the verified 23andMe v5 positions on chromosomes 1–22, check genome build and alleles, and save one prepared PLINK genotype set per chromosome for all 2,504 people | Prepared chromosomes and variant maps (cloud only) |
| 2 Verify the sample split | Confirm 2,003 unique training IDs and 501 unique test IDs, no overlap, every ID in the reference panel; save normalised lists and checksums | `train2003.txt`, `test501.txt`, `split_summary.json` |
| 3 Audit populations | Join IDs to the population panel and report training/test counts by population and broad reference group; record the relatedness audit (15 published close pairs) and group known training relatives for cross-validation | `population_counts.tsv`, `broad_group_counts.tsv`, relative-pair tables, `audit_summary.json` |
| 4 Marker QC and LD pruning | Using **only** the 2,003 training people, remove markers with excess missingness or very low allele frequency and LD-prune correlated markers; save one ordered panel with the counted (REF) allele per marker — 335,663 markers for the published model | Per-chromosome selected-marker lists and `marker_summary.json` |
| 5 Train one PCA + classifier | Compare PCA and logistic settings in three training-only folds, then fit missing-value filling (mean), scaling, PCA (10 components) and logistic regression (C = 1.0) on all 2,003 training people | `model.joblib` (cloud only), `selected_markers.tsv`, `cv_scores.json`, `training_summary.json` |
| 6 Test the frozen model | Project the 501 test people through the saved pipeline and compare with the known 1000 Genomes labels: 500 / 501 correct, with per-group accuracy, a confusion table and coverage checks; export the pipeline to ONNX and verify Python ↔ ONNX parity. Test people never influence marker selection, PCA or tuning | `predictions.tsv`, `test_summary.json`, `onnx_parity.json`, browser bundle (`model/`) |
| 7 Apply to v5 files | For compatible personal files (v5, GRCh37): match positions and alleles to the saved marker list, check usable-marker coverage, apply the same pipeline, and return the predicted group with quality checks and model version. Files with insufficient usable data receive a reason instead of an assignment; results are merged into the participant catalog | `summary.json`, `merge_audit.json`, `predictions.json`, `individuals/*.json`, `consolidated_participants.json`, `v5_build37_table.csv`, browser bundle |

Where to find this run's results — paths are `cloud/<step>/results/my23-20261028-154934/…`,
identical to the bucket (see [`cloud/README.md`](./cloud/README.md)):

| Question | File |
|----------|------|
| How many SNPs were selected and which settings won? | `5_fit_pca_and_classifier/results/<run>/training_summary.json` |
| How many of the 501 test labels were correct? | `6_test_model/results/<run>/test_summary.json` |
| How many v5 files were classified or skipped? | `7_apply_v5_classifier/results/<run>/summary.json` |
| Where are the reference people's PC coordinates? | `runs/<run>/pca_reference/train2003_pcs.tsv`, `test501_pcs.tsv` |

This repository implements step 7 for the browser: the SDK reproduces the step-7 encoding
(verified to give the identical 332,878 called markers and probabilities on the bundled demo file
as the release's own `classifier.mjs`) and runs the exported pipeline with `onnxruntime-web`.

The trained scikit-learn pipeline (`SimpleImputer → StandardScaler → PCA → LogisticRegression`,
fitted by `cloud/5_fit_pca_and_classifier/source/<run>/step.py`) is exported to ONNX by
`cloud/source/<run>/export_onnx.py` in step 6 and checked for
agreement with the Python outputs so that the npm package and web app produce the same result
as the original model.

### Browser model bundle (`model/`)

The cloud workflow's Step 6 exports the fitted pipeline to ONNX and verifies it against Python.
The web app and SDK consume that release bundle from `model/` (currently run
`my23-20261028-154934`, 335,663 markers, trained on the 2,003 training people):

| Artifact | Contents |
|----------|----------|
| `model/model.onnx` | Imputation (training means) → scaler → PCA → logistic regression → softmax. Input `genotypes[N, 335663]` float32 (REF-allele count 0/1/2, `NaN` = missing). Outputs `probabilities[N, 5]`, `class_index[N]` |
| `model/markers.json` | `{ genome_build: "37", sites: [[chrom, pos, ref, alt], …] }` in model column order (chr 1–22, no duplicate coordinates) |
| `model/metadata.json` | `classes` (AFR, AMR, EAS, EUR, SAS), `feature_count`, `input_name`, `probabilities_output`, `genome_build`, `minimum_called_fraction` (0.9), `maximum_incompatible_fraction` (0.01), `model_sha256`, `markers_sha256`, `run_id` |
| `model/pca_reference.json` | PC scores of the reference people for the PCA plot, generated by `scripts/build-pca-reference.mjs` from the cloud export: `groups.train` (2,003, known labels), `groups.test` (501, known + predicted from Step 6), optional `groups.v5_files`, plus `explained_variance_ratio` (PC1 5.6 %, PC2 3.2 %, PC1–10 11.5 %) |

The SDK verifies the SHA-256 of `markers.json` and `model.onnx` against `metadata.json` before
creating the session, and also accepts the older hand-built export layout (`{ n_markers, markers: ["chr:pos:ref:alt"] }`,
nested `coverage_rules`, extra `pc_scores` output). The current bundle does **not** emit
`pc_scores`, so uploaded files are not placed on the PCA plot; the reference layers come from
`pca_reference.json`.

#### Producing `pca_reference.json`

Steps 5 and 6 save the fitted PCA inside `model.joblib` but do not write per-person PC
coordinates, and a completed run is skipped on rerun. A separate cloud export therefore loads the
frozen model and only *transforms* — the **same fitted pipeline for both splits** (never refit on
the 501 test people):

```python
import joblib, json, pandas as pd
bundle = joblib.load("model.joblib")
pipe = bundle["pipeline"]                       # imputer -> scale -> pca -> classifier
pre = pipe[:-1]                                 # fitted preprocessing + PCA
# X_train / X_test: REF-allele dosages (0/1/2, NaN = missing), columns in bundle["markers"] order
cols = [f"PC{i+1}" for i in range(pipe.named_steps["pca"].n_components_)]
pd.DataFrame(pre.transform(X_train), index=train_ids, columns=cols).rename_axis("sample").to_csv("train2003_pcs.tsv", sep="\t")
pd.DataFrame(pre.transform(X_test),  index=test_ids,  columns=cols).rename_axis("sample").to_csv("test501_pcs.tsv",  sep="\t")
pca = pipe.named_steps["pca"]
json.dump({"n_components": int(pca.n_components_), "explained_variance_ratio": pca.explained_variance_ratio_.tolist()},
          open("pca_summary.json", "w"), indent=2)
```

Then drop `train2003_pcs.tsv`, `test501_pcs.tsv` and `pca_summary.json` (or one combined
`reference_pcs.tsv` with a `split` column) into `cloud/runs/<run_id>/pca_reference/` for the run
named in `model/metadata.json` — where the published run's export already lives — and run

```sh
node scripts/build-pca-reference.mjs        # or pass --run/--train/--test/--pcs/--predictions/--evr/--v5 paths
```

[`scripts/build-pca-reference.mjs`](./scripts/build-pca-reference.mjs) joins the tables with
`data/reference_cohort.json` (known labels, populations), checks that exactly the 2,003 / 501
cohort people are present and that any `reference_group` column agrees with the panel, refuses
tables whose `run_id` / marker count differ from `model/metadata.json`, takes the test people's
predicted groups from the Step 6 `predictions.tsv`, and writes `model/pca_reference.json`
(~280 KB). A `v5_files_pcs.tsv` (file ID + PCs + predicted group) from Step 7 adds the PGP layer.

ONNX Runtime Web **1.22.0** is vendored in `vendor/onnxruntime-web/` (`ort.wasm.min.mjs` +
`ort-wasm-simd-threaded.{mjs,wasm}`, byte-identical to the npm release) so the deployed site has
no CDN dependency and runs the same single-threaded WASM configuration that the cloud export was
verified with. The WASM-only entry is used deliberately: the full `ort.min.mjs` build requests the
`*.jsep.*` WebGPU binaries, which are not shipped.

If `model/metadata.json` is absent the web app shows **"model bundle not published yet"** and
still parses, inspects and tabulates files.

## Installation (SDK)

```sh
npm install ancestry-classification-for-v5-23andme-files
```

```js
import { classifyAncestry } from "ancestry-classification-for-v5-23andme-files";

const text = await file.text(); // raw 23andMe v5 export
const result = await classifyAncestry(text);

result.status;             // "classified" | "skipped" (see result.reason) 
result.group;              // e.g. "EUR"
result.scores;             // { AFR: 0.01, AMR: 0.03, EAS: 0.00, EUR: 0.95, SAS: 0.01 }
result.pcScores;           // [PC1, PC2, …] — the file's coordinates on the saved PCA
result.coverage;           // fraction of model markers called in the file
result.calledMarkers;      // 332847
result.incompatibleMarkers;// markers whose alleles were not {REF, ALT} (imputed in-graph)
result.model.version;      // from metadata.json
result.model.sha256;       // checksum of model.onnx
```

Lower-level pieces are exported too: `parse23andMe(text)`, `encodeDosages(parsed)`,
`coverageProblem(encoded)`, `loadModel()`, `loadPcaReference()`, `modelStatus()` and
`configure({ modelBase, ortBase })` to point at a different bundle location or ONNX Runtime
directory (the web app uses the vendored copy in `vendor/onnxruntime-web/`; the default for npm
consumers is the pinned jsDelivr CDN). Source: `src/sdk/`.

## Web app

Open the web app, select your 23andMe raw-data file, and the page shows the closest
1000 Genomes reference group, the per-group scores, and marker coverage. Processing happens
locally in the browser.

The landing page lives in [`index.html`](./index.html) (styles in `src/css/`, logic in
`src/app/app.js`) and has four tabs:

1. **Upload & Classify** – drag-and-drop or browse for one or more `.txt` exports, or press **Try a demo file**
   to load the bundled real 23andMe v5 export (`data/demo_genotype_file/genome_23.txt`, 631,455 variants).
   The status line shows the cloud pipeline's result for that file (AMR, 332,847 markers called) so you can compare.
2. **Participants** – one searchable, filterable, sortable table combining three sources (Source filter):
   - **1000G train / test** – the 2,003 training and 501 held-out 1000 Genomes people from
     `data/reference_cohort.json`, with population code and name, sex and *known* super-population label
     (shown as an outlined badge, never as a prediction);
   - **PGP catalog** – 885 public PGP participants / 1,018 23andMe files from `data/participants_catalog.json`
     (chip version, build, variant count, file validity, self-reported sex / race / ethnicity, birth year, state,
     predicted reference group, called-marker fraction);
   - **Uploaded** – files you load in the Upload tab.
   Includes per-group counts for known vs. predicted labels, pagination and CSV export.
3. **Inspect Genotypes** – paginated genotype table with rsID / position search, chromosome and genotype-class filters, column sorting and CSV export.
4. **PCA Plot** – every person projected onto the model's saved principal components (Plotly, WebGL).
   Layers: 1000G train (2,003, translucent circles, known label), 1000G test (501, diamonds, known label —
   hover shows the prediction and flags misclassifications), PGP v5 files (74, squares, predicted) and your
   uploads (large labelled stars, from the model's `pc_scores` output). Choose any PCx / PCy pair, colour by
   reference group, 1000G population or data source, toggle layers, and download the coordinates as CSV.
   Requires `model/pca_reference.json` for the reference layers.

### Data

Paths below follow the *Repository layout* above; the three generated files are rebuilt from
`cloud/` by `scripts/`.

| File | Contents |
|------|----------|
| `data/demo_genotype_file/genome_23.txt` | Real, anonymised 23andMe v5 export (GRCh37, 631,455 variants, 16 MB) used by the *Try a demo file* button. The SDK encoder yields 332,847 called model markers on it — identical to the cloud pipeline's record for the same file |
| `data/participants_catalog.json` | Generated by `build-catalog.mjs` from the Step 7 `consolidated_participants.json` + `chip_match_results.json`: slim per-file catalog for the web app (no real names, zip codes or storage-host URLs). The 74 PGP predictions (group, coverage, per-group probabilities) are the published run's Step 7 results |
| `data/reference_cohort.json` | Generated by `build-cohort.mjs`: the 2,504 reference people with split, population, super-population and sex, plus per-group counts (train: AFR 524 · AMR 272 · EAS 400 · EUR 408 · SAS 399; test: AFR 137 · AMR 75 · EAS 104 · EUR 95 · SAS 90). Test rows also carry the published model's `predicted` group and `probs`; `summary.test.evaluation` holds accuracy, confusion, misclassified samples and ONNX parity, and `summary.trainingRun` the run provenance |
| `model/` (published from the cloud run) | Browser model bundle: `model.onnx`, `markers.json`, `metadata.json`, `pca_reference.json` — see *Browser model bundle* above |
| `cloud/` | Verbatim mirror of the pipeline bucket for run `my23-20261028-154934` — code, staged inputs and results of all seven steps, plus the PC-coordinate export. What each folder holds, what is excluded from git and how to mirror a run: [`cloud/README.md`](./cloud/README.md) |
| `docs/23andMe_v5_single_model_pipeline_steps_1_to_7.docx` | Plan for the single-model seven-step cloud workflow summarised in *How the model was built* |
| `vendor/onnxruntime-web/` | Pinned ONNX Runtime Web 1.22.0 (`ort.wasm.min.mjs`, `ort-wasm-simd-threaded.{mjs,wasm}`) |

Regenerate the slim catalog, the reference cohort and the PCA reference after updating the inputs:

```sh
npm run build:data      # = build:catalog + build:cohort + build:pca
```

To run it locally, serve the repo root with any static server, e.g.

```sh
npx http-server -p 8080
# then open http://localhost:8080/
```

The Classify buttons call the SDK in `src/sdk/classifier.js`, which loads `model/` on demand.
If the bundle is missing, the Upload tab shows a *model bundle not published yet* badge and
classification results read "model pending". With the bundle present, the demo file's status line
compares the browser result with the reference result for the same file (group and
called-marker count).

## Interpreting the result

- The output is a **genetic similarity to a reference group**, not an ancestry-mixture
  proportion. The five classifier scores should not be used as admixture weights.
- **AMR** denotes the admixed American reference populations of 1000 Genomes and should not
  be read as an Indigenous American label.
- Genetic group assignment is separate from self-reported race and ethnicity.
- A file that fails input checks returns the reason, and the classifier output is withheld.

## Related work

The classifier is also used as a building block for downstream work such as evaluating
polygenic-risk-score imputation (e.g. a FastImpute reproduction for PRS313 / PGS000004)
across reference groups. That analysis is separate from, and not required for, using this
package to classify a 23andMe file.

## References

1. 1000 Genomes Project Consortium. A global reference for human genetic variation.
   *Nature*. 2015;526:68-74. https://doi.org/10.1038/nature15393
2. Ge A, Balasubramanian J, Wu X, Kraft P, Almeida JS. FastImpute: Development and
   Validation of a Workflow for Open-source, Reference-Free Genotype Imputation Methods.
   *The Open Bioinformatics Journal*. 2026;19. https://doi.org/10.2174/0118750362421210250929110508
3. Scikit-learn developers. Model persistence (ONNX export).
   https://scikit-learn.org/stable/model_persistence.html
