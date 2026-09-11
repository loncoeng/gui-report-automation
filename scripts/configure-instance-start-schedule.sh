#!/usr/bin/env bash
set -euo pipefail

project_id="${PROJECT_ID:-example-project}"
instance="${INSTANCE_NAME:-gui-report-automation}"
zone="${INSTANCE_ZONE:-asia-northeast1-c}"
region="${INSTANCE_REGION:-asia-northeast1}"
policy="${START_POLICY_NAME:-gui-report-automation-daily-start}"
schedule="${VM_START_SCHEDULE:-0 6 1,3-31 * *}"

if ! gcloud compute resource-policies describe "$policy" \
  --project="$project_id" --region="$region" >/dev/null 2>&1; then
  gcloud compute resource-policies create instance-schedule "$policy" \
    --project="$project_id" \
    --region="$region" \
    --vm-start-schedule="$schedule" \
    --timezone="Asia/Tokyo"
fi

current="$(gcloud compute instances describe "$instance" \
  --project="$project_id" --zone="$zone" \
  --format='value(resourcePolicies.basename())')"
if ! grep -Fxq "$policy" <<<"$current"; then
  gcloud compute instances add-resource-policies "$instance" \
    --project="$project_id" --zone="$zone" \
    --resource-policies="$policy"
fi

gcloud compute resource-policies describe "$policy" \
  --project="$project_id" --region="$region" \
  --format='yaml(name,instanceSchedulePolicy)'
