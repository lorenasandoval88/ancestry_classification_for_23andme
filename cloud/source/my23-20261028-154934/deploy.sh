#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

export PROJECT_ID="${PROJECT_ID:-nih-nci-dceg-episphere-dev}"
export REGION="${REGION:-us-east4}"
export REPO="${REPO:-phase3-download}"
export JOB_NAME="${JOB_NAME:-my23-v5-ancestry-model}"
export RUNTIME_SA="${RUNTIME_SA:-phase3-reference-download@${PROJECT_ID}.iam.gserviceaccount.com}"
export OUTPUT_ROOT="${OUTPUT_ROOT:-gs://all23_0710/ancestry/my23_v5_ancestry_model}"
export RUN_ID="${RUN_ID:-my23-$(date -u +%Y%m%d-%H%M%S)}"

account="$(gcloud auth list --filter=status:ACTIVE --format='value(account)')"
if [[ -z "$account" ]]; then
  echo 'No active Google account. Run gcloud auth login, then rerun this script.' >&2
  exit 1
fi
command -v python3 >/dev/null
gcloud services enable run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com \
  --project="$PROJECT_ID"
gcloud iam service-accounts describe "$RUNTIME_SA" --project="$PROJECT_ID" >/dev/null

# Bucket-scoped access only; no project IAM edits and no downloaded account keys.
if [[ "${SETUP_BUCKET_IAM:-1}" == 1 ]]; then
  for role in roles/storage.objectViewer roles/storage.objectCreator; do
    gcloud storage buckets add-iam-policy-binding gs://all23_0710 \
      --member="serviceAccount:${RUNTIME_SA}" --role="$role" --condition=None \
      --project="$PROJECT_ID" >/dev/null
  done
  gcloud storage buckets add-iam-policy-binding gs://ref1000g \
    --member="serviceAccount:${RUNTIME_SA}" --role=roles/storage.objectViewer \
    --condition=None --project="$PROJECT_ID" >/dev/null
fi

if description="$(gcloud artifacts repositories describe "$REPO" --location="$REGION" --project="$PROJECT_ID" 2>&1)"; then
  :
elif [[ "$description" == *NOT_FOUND* || "$description" == *"not found"* ]]; then
  gcloud artifacts repositories create "$REPO" --repository-format=docker \
    --location="$REGION" --project="$PROJECT_ID" --description='Ancestry workflow containers'
else
  echo "$description" >&2
  exit 1
fi

python3 bootstrap.py
source .deployment/run.env
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/my23-v5-ancestry-model:${RUN_ID}"
# Explicit build -> image deployment avoids the earlier source-deployment IAM path.
gcloud builds submit --project="$PROJECT_ID" --tag="$IMAGE" .
gcloud run jobs deploy "$JOB_NAME" --image="$IMAGE" --project="$PROJECT_ID" --region="$REGION" \
  --service-account="$RUNTIME_SA" --tasks=1 --parallelism=1 --cpu=8 --memory=32Gi \
  --task-timeout=24h --max-retries=0 --args=train \
  --set-env-vars="CONFIG_URI=${CONFIG_URI},CONFIG_SHA256=${CONFIG_SHA256}" --quiet

echo "Deployed; execution has NOT started. RUN_ID=${RUN_ID}"
echo "Run all seven: gcloud run jobs execute ${JOB_NAME} --project=${PROJECT_ID} --region=${REGION} --args=all --async"
echo "Or steps 1-6: gcloud run jobs execute ${JOB_NAME} --project=${PROJECT_ID} --region=${REGION} --args=train --async"
echo "Then step 7: gcloud run jobs execute ${JOB_NAME} --project=${PROJECT_ID} --region=${REGION} --args=apply --async"
echo "Saved inputs, code, and results: ${OUTPUT_ROOT}/"
