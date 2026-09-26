#!/usr/bin/env bash
# Put the provider keys in Parameter Store, where remote.sh reads them.
#
#   infra/aws/set-keys.sh [env file]     (default: the repository's .env)
#
# Only NVIDIA_API_KEYS, GROQ_API_KEYS, GEMINI_API_KEYS and XAI_API_KEY are read,
# and only non-empty ones are written, as SecureString under /wattsteer/keys/.
# The next deploy applies them. Values never reach a bucket, an image or a log.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
HERE="$ROOT/infra/aws"
AWS="$HERE/scripts/aws.sh"
# shellcheck source=/dev/null
. "$HERE/stack.env"
export AWS_DEFAULT_REGION="$AWS_REGION"
FILE="${1:-$ROOT/.env}"

grep -E '^(NVIDIA_API_KEYS|GROQ_API_KEYS|GEMINI_API_KEYS|XAI_API_KEY)=.' "$FILE" |
  while IFS='=' read -r key value; do
    value="${value%\"}"
    value="${value#\"}"
    "$AWS" ssm put-parameter --name "/wattsteer/keys/$key" --type SecureString \
      --value "$value" --overwrite >/dev/null </dev/null  # docker -i would eat the loop's input
    echo "   $key"
  done
echo "== stored; run infra/aws/deploy.sh to apply them"
