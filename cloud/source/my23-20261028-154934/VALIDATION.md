# Validation record

Created for the single-model 2,003/501 rebuild, 28 October 2026.

## Passed locally

- JavaScript syntax and Python compilation for the generated package.
- Bash syntax for `deploy.sh`.
- Ten Python tests: ID validation and exact split membership despite differing
  headers/line endings/order, rejection of changed/duplicate people;
  REF-dosage and exported-column ordering;
  missing calls, incompatible alleles, and conflicting duplicates; related-group
  CV folds; identity-based joins and profile preservation; conflicting predictions
  for a person; numerical parameter equivalence to the fitted sklearn pipeline;
  and restoration after a simulated partial model-artifact upload.
- Browser JavaScript parser checks for the same genotype/duplicate/build rules.
- Preparation parser self-test, including all 601,871 embedded positions and the
  compact derivative's recorded SHA-256.
- `node index.js all --dry-run`: seven intended steps, correct destination,
  2,003 training people, 501 test people, and no cloud reads/writes.
- Integration of the attached NEW consolidated JSON with the attached chip report:
  885 participants / 1,018 file records preserved; 74 eligible files / 72 people;
  all 74 uniquely linked by stored GCS file paths; all profiles preserved.
  Synthetic join-test predictions were held in memory only and not delivered
  as ancestry results.

The local numerical tests used installed NumPy 2.3.5 / scikit-learn 1.8.0 /
joblib 1.5.3. The container pins the original training stack (NumPy 2.2.6 /
scikit-learn 1.7.2 / joblib 1.5.2) and reruns its tests there.

## Required cloud-build gates, not run here

This workspace could not install ONNX/ONNX Runtime and does not have PLINK,
bcftools, or Docker. The Docker build runs:

- The same ten Python tests and browser-parser checks.
- A synthetic fitted-pipeline export, ONNX structural validation, and actual ONNX
  Runtime comparison on 90 synthetic samples.
- Real bcftools/PLINK conversion on a toy 64-sample VCF, checking removal of
  indels/multiallelic records, REF-counted dosage including missing calls,
  PGEN/PVAR/PSAM loading, missingness QC, and LD-pruning command compatibility.
- Availability of the pinned browser runtime's JavaScript/WASM files.

## Not performed

No GCS object was read or written and no IAM binding, Cloud Build, Cloud Run
deployment, or full 1000 Genomes training/evaluation was executed from this
workspace. Actual bucket object names and permissions are checked by deployment.
Step 6 must pass actual ONNX/Python parity on the 501 reference test samples.
Step 7 must pass actual ONNX/Python parity on eligible personal-file predictions.
The browser release still needs an actual browser check against a matching cloud
file result before publication. A source-code check is not an end-to-end result.
