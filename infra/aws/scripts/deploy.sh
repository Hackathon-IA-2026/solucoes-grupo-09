#!/usr/bin/env bash
# Deploy WattSteer to AWS with one command.
#
#   infra/aws/scripts/deploy.sh ecs            # ECS Fargate option
#   infra/aws/scripts/deploy.sh ec2            # EC2 + Compose option
#   infra/aws/scripts/deploy.sh ecs --plan     # show what would change, touch nothing
#
# Flags: --yes (no confirmation prompt), --allow-destroy (accept a plan that
# deletes or replaces something; never needed for a normal deploy).
#
# What it does, in order, stopping at the first failure:
#   1. check the account, the backend file and the git tree
#   2. apply the foundation: network, image registry, storage, secrets
#      placeholders, and the public address the web image needs
#   3. refuse to go on while a required secret is still unset
#   4. build the five images for arm64 and push them, tagged with the commit
#   5. apply everything with that tag, running the migration first
#   6. wait for the services and check the site answers
#
# Every apply goes through a saved plan that scripts/guard_plan.py reads: a
# plan that deletes or replaces anything stops the deploy (see that file).
#
# WATTSTEER_SIM=1 points every call at the local simulator instead of AWS
# (infra/aws/sim/simulate.sh sets it); the steps only real AWS can do are
# skipped and say so.
set -euo pipefail

INFRA="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$INFRA/../.." && pwd)"
TF="$INFRA/scripts/tf.sh"
AWS="$INFRA/scripts/aws.sh"

OPTION="${1:?usage: deploy.sh <ecs|ec2> [--plan] [--yes] [--allow-destroy]}"
shift
case "$OPTION" in ecs | ec2) ;; *) echo "option must be ecs or ec2" >&2; exit 2 ;; esac
PLAN_ONLY=0 YES=0 GUARD_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --plan) PLAN_ONLY=1 ;;
    --yes) YES=1 ;;
    --allow-destroy) GUARD_ARGS=(--allow-destroy) ;;
    *) echo "unknown flag $arg" >&2; exit 2 ;;
  esac
done

SIM="${WATTSTEER_SIM:-0}"
# The CLI reads AWS_REGION and Terraform reads var.region; one must not drift
# from the other, or the plan lands in a region the rest of the deploy is not in.
if [ -n "${AWS_REGION:-}" ] && [ -z "${TF_VAR_region:-}" ]; then export TF_VAR_region="$AWS_REGION"; fi
# Each option has its own prefix (the `name` variable's default in its root),
# so trying ecs and falling back to ec2 in the same account never collides.
if [ "$OPTION" = "ecs" ]; then NAME=wattsteer; else NAME=wattsteer-ec2; fi
step() { printf '\n==> %s\n' "$*"; }

# --- 1. preflight ----------------------------------------------------------

step "1/6 preflight"
if [ "$SIM" = "1" ]; then
  BACKEND="$INFRA/sim/backend.hcl"
  cp "$INFRA/sim/aws_override.tf" "$INFRA/$OPTION/zz_sim_override.tf"
  [ -f "$INFRA/sim/${OPTION}_override.tf" ] && cp "$INFRA/sim/${OPTION}_override.tf" "$INFRA/$OPTION/zz_sim_${OPTION}_override.tf"
  trap 'rm -f "$INFRA/$OPTION"/zz_sim_*override.tf "$INFRA/$OPTION/plan.out"' EXIT
  echo "simulation: every AWS call goes to the local simulator"
else
  BACKEND="$INFRA/backend.hcl"
  trap 'rm -f "$INFRA/$OPTION/plan.out"' EXIT
  [ -f "$BACKEND" ] || { echo "missing $BACKEND — copy backend.hcl.example (README, step 2)" >&2; exit 1; }
  identity="$("$AWS" sts get-caller-identity --output text --query '[Account,Arn]')"
  echo "AWS account and identity: $identity"
  echo "region: ${AWS_REGION:-${AWS_DEFAULT_REGION:-from ~/.aws/config}}"
fi

TAG="$(git -C "$REPO" rev-parse --short=12 HEAD)"
# ecs pins the tag in its task definitions; ec2 passes it to up.sh instead.
TAG_VARS=()
if [ "$OPTION" = "ecs" ]; then TAG_VARS=(-var "image_tag=$TAG"); fi
if [ -n "$(git -C "$REPO" status --porcelain)" ]; then
  echo "warning: the working tree has uncommitted changes; they are in the images but not in the tag $TAG"
fi
echo "option: $OPTION   image tag: $TAG"

if [ "$YES" != "1" ] && [ "$PLAN_ONLY" != "1" ] && [ "$SIM" != "1" ]; then
  read -r -p "Deploy to this account? Type 'deploy' to continue: " answer
  [ "$answer" = "deploy" ] || { echo "stopped"; exit 1; }
fi

# TF_INIT_ARGS is split on purpose: it carries whole flags (the simulation's -plugin-dir).
# shellcheck disable=SC2086
"$TF" "$OPTION" init -input=false -reconfigure \
  -backend-config="/infra/${BACKEND#"$INFRA"/}" \
  -backend-config="key=$OPTION/terraform.tfstate" \
  ${TF_INIT_ARGS:-} >/dev/null
echo "terraform initialised (state: $OPTION/terraform.tfstate)"

# plan → guard → apply, always through a saved plan file.
apply() {
  "$TF" "$OPTION" plan -input=false -out=plan.out "$@" >/dev/null
  "$TF" "$OPTION" show -no-color plan.out | grep -E '^\s+# |^Plan:|^No changes' || true
  "$TF" "$OPTION" show -json plan.out | python3 "$INFRA/scripts/guard_plan.py" ${GUARD_ARGS[@]+"${GUARD_ARGS[@]}"}
  if [ "$PLAN_ONLY" = "1" ]; then return 0; fi
  "$TF" "$OPTION" apply -input=false plan.out
}

# A Terraform output: a string as is, a list comma-separated, a map as JSON.
output() {
  "$TF" "$OPTION" output -json | python3 -c "
import json, sys
value = json.load(sys.stdin)['$1']['value']
print(value if isinstance(value, str) else ','.join(value) if isinstance(value, list) else json.dumps(value))"
}

if [ "$PLAN_ONLY" = "1" ]; then
  step "plan only (nothing is applied)"
  apply ${TAG_VARS[@]+"${TAG_VARS[@]}"}
  exit 0
fi

# --- 2. foundation ------------------------------------------------------------

step "2/6 foundation: network, registry, storage, public address"
if [ "$OPTION" = "ecs" ]; then address_target=aws_lb.this; else address_target=aws_eip.this; fi
apply -target=module.network -target=module.registry -target=module.storage -target="$address_target"
PUBLIC_URL="$(output public_url)"
REGISTRY="$(output repository_urls | python3 -c "import json,sys; print(json.load(sys.stdin)['api'].split('/')[0])")"
echo "public URL: $PUBLIC_URL"

# --- 3. secrets -------------------------------------------------------------------

step "3/6 secrets"
# The backticks are JMESPath literals for the AWS CLI, not shell.
# shellcheck disable=SC2016
unset_secrets="$("$AWS" ssm get-parameters --with-decryption \
  --names "/$NAME/NVIDIA_API_KEYS" "/$NAME/GROQ_API_KEYS" \
  --query 'Parameters[?Value==`unset`].Name' --output text)"
if [ -n "$unset_secrets" ] && [ "$unset_secrets" != "None" ]; then
  echo "still unset: $unset_secrets"
  echo "run: infra/aws/scripts/set-secrets.sh $OPTION <your env file>   (README, step 4), then deploy again"
  exit 1
fi
cesium_token="$("$AWS" ssm get-parameter --with-decryption --name "/$NAME/EXPO_PUBLIC_CESIUM_ION_TOKEN" \
  --query Parameter.Value --output text 2>/dev/null || echo unset)"
[ "$cesium_token" = "unset" ] && cesium_token=""
echo "required secrets are set"

# --- 4. images ---------------------------------------------------------------------

step "4/6 images for linux/arm64, tag $TAG"
build() { # <image> <dockerfile> <context> [build args...]
  local image="$1" dockerfile="$2" context="$3"
  shift 3
  docker buildx build --platform linux/arm64 --load \
    --build-arg "GIT_SHA=$TAG" --build-arg "BUILD_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    "$@" -f "$REPO/$dockerfile" -t "$REGISTRY/$NAME/$image:$TAG" "$REPO/$context" >/dev/null
  echo "built $image"
}
build api apps/api/Dockerfile .
build ml apps/ml/Dockerfile apps/ml
build rag apps/rag/Dockerfile .
build migrate infra/aws/docker/migrate.Dockerfile .
build web apps/web/Dockerfile . \
  --build-arg "EXPO_PUBLIC_API_URL=$PUBLIC_URL" \
  --build-arg "EXPO_PUBLIC_SITE_URL=$PUBLIC_URL" \
  --build-arg "EXPO_PUBLIC_CESIUM_ION_TOKEN=$cesium_token"

if [ "$SIM" = "1" ]; then
  echo "[sim] push skipped: the images stay local, tagged $REGISTRY/$NAME/<image>:$TAG"
else
  "$AWS" ecr get-login-password | docker login --username AWS --password-stdin "$REGISTRY" >/dev/null
  for image in api ml rag migrate web; do
    docker push -q "$REGISTRY/$NAME/$image:$TAG" >/dev/null
    echo "pushed $image"
  done
fi

# --- 5. release ------------------------------------------------------------------

step "5/6 release $TAG"
if [ "$OPTION" = "ecs" ]; then
  # The migration first, on its own task definition, then every service.
  apply ${TAG_VARS[@]+"${TAG_VARS[@]}"} -target=aws_ecs_task_definition.migrate
  if [ "$SIM" = "1" ]; then
    echo "[sim] migration task skipped (sim/run_task_defs.py runs it in Docker)"
  else
    subnets="$(output task_subnets)"
    task="$("$AWS" ecs run-task --cluster "$(output cluster)" --launch-type FARGATE \
      --task-definition "$(output migrate_task_definition)" \
      --network-configuration "awsvpcConfiguration={subnets=[$subnets],securityGroups=[$(output task_security_group)],assignPublicIp=ENABLED}" \
      --query 'tasks[0].taskArn' --output text)"
    echo "migration running: $task"
    "$AWS" ecs wait tasks-stopped --cluster "$(output cluster)" --tasks "$task"
    code="$("$AWS" ecs describe-tasks --cluster "$(output cluster)" --tasks "$task" \
      --query 'tasks[0].containers[0].exitCode' --output text)"
    [ "$code" = "0" ] || { echo "migration failed (exit $code); logs: /$NAME/migrate in CloudWatch"; exit 1; }
    echo "migration applied"
  fi
  apply ${TAG_VARS[@]+"${TAG_VARS[@]}"}
else
  apply ${TAG_VARS[@]+"${TAG_VARS[@]}"}
  if [ "$SIM" = "1" ]; then
    echo "[sim] instance rollout skipped (sim/smoke.sh runs compose.aws.yml in Docker)"
  else
    bucket="$(output deploy_bucket)"
    command_id="$("$AWS" ssm send-command --instance-ids "$(output instance_id)" \
      --document-name AWS-RunShellScript \
      --parameters "commands=[\"aws s3 cp s3://$bucket/deploy/up.sh /opt/wattsteer/up.sh\",\"bash /opt/wattsteer/up.sh $TAG $bucket\"]" \
      --query Command.CommandId --output text)"
    echo "rollout running on the instance: $command_id"
    "$AWS" ssm wait command-executed --command-id "$command_id" --instance-id "$(output instance_id)" ||
      { echo "rollout failed; see: aws ssm get-command-invocation --command-id $command_id --instance-id $(output instance_id)"; exit 1; }
  fi
fi

# --- 6. check ----------------------------------------------------------------------

step "6/6 check"
if [ "$SIM" = "1" ]; then
  echo "[sim] live check skipped"
  exit 0
fi
if [ "$OPTION" = "ecs" ]; then
  # shellcheck disable=SC2046
  "$AWS" ecs wait services-stable --cluster "$(output cluster)" \
    --services $(output services | tr ',' ' ')
fi
for path in /healthz /v1/meta; do
  ok=0
  for _ in $(seq 1 30); do
    if curl -fsS -o /dev/null "$PUBLIC_URL$path"; then ok=1; break; fi
    sleep 10
  done
  [ "$ok" = "1" ] || { echo "no answer from $PUBLIC_URL$path after 5 minutes"; exit 1; }
  echo "ok  $PUBLIC_URL$path"
done
echo
echo "deployed $TAG → $PUBLIC_URL"
