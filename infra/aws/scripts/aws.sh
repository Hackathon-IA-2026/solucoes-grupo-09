#!/usr/bin/env bash
# The AWS CLI, from its official image, so nobody installs it.
#   infra/aws/scripts/aws.sh sts get-caller-identity
# Credentials and region come from the caller's environment and ~/.aws.
set -euo pipefail

env_args=()
while IFS='=' read -r name _; do
  case "$name" in AWS_*) env_args+=(-e "$name") ;; esac
done < <(env)

exec docker run --rm -i \
  --network "${AWS_DOCKER_NETWORK:-host}" \
  -v "${HOME}/.aws:/root/.aws:ro" \
  ${env_args[@]+"${env_args[@]}"} \
  "${AWS_CLI_IMAGE:-amazon/aws-cli:latest}" "$@"
