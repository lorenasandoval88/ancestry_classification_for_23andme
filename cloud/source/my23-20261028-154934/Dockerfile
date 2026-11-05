FROM gcr.io/google.com/cloudsdktool/google-cloud-cli:stable
ENV DEBIAN_FRONTEND=noninteractive \
    PATH="/opt/venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    CLOUDSDK_STORAGE_PARALLEL_COMPOSITE_UPLOAD_ENABLED=false \
    OPENBLAS_NUM_THREADS=4 OMP_NUM_THREADS=4 MKL_NUM_THREADS=4
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-venv nodejs npm plink2 bcftools tabix zstd ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/venv
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && npm install --prefix /opt/ort --no-audit --no-fund onnxruntime-web@1.22.0
COPY . ./
RUN node --check index.js \
    && node --check 1_prepared_data/source/prepare.js \
    && node 1_prepared_data/source/prepare.js --self-test \
    && python tests/test_pipeline.py --onnx \
    && node tests/test_browser_parser.mjs \
    && python tests/test_plink.py \
    && plink2 --help | grep -q -- '--export-allele' \
    && command -v bcftools && command -v zstd && command -v gcloud \
    && test -f /opt/ort/node_modules/onnxruntime-web/dist/ort.min.mjs \
    && test -f /opt/ort/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs \
    && test -f /opt/ort/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm
ENTRYPOINT ["node", "/app/index.js"]
CMD ["train"]
