#!/usr/bin/env bash
# Put the provider keys into SSM, from a local env file that never leaves the
# laptop and is never committed.
#
#   infra/aws/scripts/set-secrets.sh path/to/secrets.env
#
# The file holds lines like NVIDIA_API_KEYS=nvapi-...,nvapi-... . Only the
# names Terraform created a parameter for are written (see
# modules/storage/main.tf, `operator_secrets`); anything else in the file is
# ignored, so a copy of a bigger .env is safe to pass. Values are never
# printed.
set -euo pipefail

FILE="${1:?usage: set-secrets.sh <env file>}"
NAME="${WATTSTEER_NAME:-wattsteer}"
AWS="$(dirname "$0")/aws.sh"
ALLOWED="NVIDIA_API_KEYS GROQ_API_KEYS XAI_API_KEY EXPO_PUBLIC_CESIUM_ION_TOKEN"

written=0
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in '' | \#*) continue ;; esac
  key="${line%%=*}"
  value="${line#*=}"
  value="${value%\"}"; value="${value#\"}"
  case " $ALLOWED " in *" $key "*) ;; *) continue ;; esac
  [ -n "$value" ] || continue
  "$AWS" ssm put-parameter --name "/$NAME/$key" --type SecureString --overwrite \
    --value "$value" </dev/null >/dev/null  # aws.sh reads stdin; keep it off this file
  echo "set /$NAME/$key"
  written=$((written + 1))
done < "$FILE"

echo "$written secret(s) written"
