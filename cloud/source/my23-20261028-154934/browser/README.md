# Browser release

Host this complete folder over HTTP(S), including `vendor/`. Do not open
`index.html` using a file:// URL. For a local preview, use `python3 -m http.server
8000` in this folder and visit http://localhost:8000.

The release contains `model.onnx`, ordered `markers.json`, `metadata.json`,
`classifier.mjs`, the demo page, and a pinned ONNX Runtime Web 1.22.0 WASM runtime.
No Python is required for a deployed browser classifier. No participant profiles,
identifiable predictions, or raw genotype files belong in a public website/repo.

The parser counts REF alleles (0/1/2), checks build-37 headers, leaves incompatible
alleles/conflicting duplicates missing, and retains the exact training marker
order. It does not silently complement strands. The ONNX graph contains the saved
training means, scaling, PCA, and classifier. Only known v5/build-37 files are
supported; coverage is not an independent chip-version test. The 90% coverage and
1% mismatch gates are operational reporting rules, not validated accuracy cutoffs.

Before publishing, select the same known input file here and in the Step 7 cloud
batch. Compare its group, marker counts, missingness, and probabilities. Cloud
tests verify Python ONNX Runtime; they do not prove the browser integration.
The current app uses a single WASM thread and processes files sequentially.

For integration, import `createClassifier` from `classifier.mjs`, provide the
matching ONNX Runtime Web instance, and call `classifier.classify(file)` for each
File object. The browser returns reference-group probabilities, not mixture
percentages or disease risk.
