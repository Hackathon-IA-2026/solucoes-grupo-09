#!/usr/bin/env bash
# Terraform, from its official image, so nobody installs it.
#
#   infra/aws/scripts/tf.sh <root> <terraform args...>
#   infra/aws/scripts/tf.sh ecs plan
#
# <root> is ecs, ec2 or bootstrap. AWS credentials come from the caller's
# environment (AWS_PROFILE with ~/.aws, or AWS_ACCESS_KEY_ID/…), and
# TF_VAR_* variables pass through. Providers are cached in a Docker volume so
# they are downloaded once, and Terraform's working directory (.terraform) lives
# in another, so nothing but the lock file is written into the repository.
set -euo pipefail

INFRA="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="${1:?usage: tf.sh <ecs|ec2|bootstrap> <terraform args...>}"
shift
TERRAFORM_IMAGE="${TERRAFORM_IMAGE:-hashicorp/terraform:1.13}"

env_args=()
while IFS='=' read -r name _; do
  case "$name" in
    AWS_* | TF_VAR_* | TF_LOG | TF_CLI_ARGS*) env_args+=(-e "$name") ;;
  esac
done < <(env)

tty_args=()
if [ -t 0 ] && [ -t 1 ]; then tty_args=(-it); fi

exec docker run --rm ${tty_args[@]+"${tty_args[@]}"} \
  --network "${TF_DOCKER_NETWORK:-host}" \
  -v "$INFRA:/infra" \
  -v "${HOME}/.aws:/root/.aws:ro" \
  -v wattsteer-tf-plugins:/plugins \
  -v wattsteer-tf-data:/tfdata \
  -e TF_PLUGIN_CACHE_DIR=/plugins \
  -e "TF_DATA_DIR=/tfdata/$ROOT" \
  -e TF_IN_AUTOMATION=1 \
  ${env_args[@]+"${env_args[@]}"} \
  -w "/infra/$ROOT" \
  "$TERRAFORM_IMAGE" "$@"
