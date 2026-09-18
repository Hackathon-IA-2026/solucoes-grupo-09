#!/usr/bin/env bash
# The whole deploy, end to end, against a local AWS simulator. No account,
# no credentials, nothing leaves this machine.
#
#   infra/aws/sim/simulate.sh            # both options
#   infra/aws/sim/simulate.sh ecs        # one option
#
# 1. starts Moto (an open-source AWS simulator) on a Docker network with no
#    route to the internet, so no call can reach real AWS by mistake
# 2. applies bootstrap/, then runs scripts/deploy.sh exactly as on the day:
#    the first run must stop at the secrets check, the second must finish
# 3. starts the containers the way AWS would run them: the ECS task
#    definitions (sim/run_task_defs.py) or the EC2 compose stack (sim/smoke.sh)
# 4. checks a second plan deletes and replaces nothing
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
INFRA="$(cd "$HERE/.." && pwd)"
OPTIONS=("${@:-ecs ec2}")
# shellcheck disable=SC2206
OPTIONS=(${OPTIONS[*]})

export WATTSTEER_SIM=1
export TF_DOCKER_NETWORK=wattsteer-sim AWS_DOCKER_NETWORK=wattsteer-sim
export AWS_ENDPOINT_URL=http://moto:5000 AWS_REGION=us-east-1
export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test
export TF_INIT_ARGS="-plugin-dir=/plugins"

step() { printf '\n##### %s\n' "$*"; }

step "simulator"
docker rm -f wattsteer-moto >/dev/null 2>&1 || true
docker network rm wattsteer-sim >/dev/null 2>&1 || true
docker network create --internal wattsteer-sim >/dev/null
docker run -d --name wattsteer-moto --network wattsteer-sim --network-alias moto \
  -e MOTO_IAM_LOAD_MANAGED_POLICIES=true motoserver/moto:latest >/dev/null
trap 'docker rm -f wattsteer-moto >/dev/null 2>&1; docker network rm wattsteer-sim >/dev/null 2>&1; rm -f "$INFRA"/*/zz_sim_*override.tf' EXIT
echo "Moto on an internal network (no internet route)"

step "providers (downloaded once, on the normal network)"
# Terraform's working directories only (scripts/tf.sh keeps them in this
# volume): a stale one would point at another backend. The deploy
# re-initialises with -reconfigure, so nothing depends on them.
docker volume rm wattsteer-tf-data >/dev/null 2>&1 || true
for root in bootstrap ecs ec2; do
  TF_DOCKER_NETWORK=bridge "$INFRA/scripts/tf.sh" "$root" init -backend=false -input=false >/dev/null
done
echo "cached"

step "bootstrap: the state bucket"
cp "$HERE/aws_override.tf" "$INFRA/bootstrap/zz_sim_override.tf"
mkdir -p "$HERE/.state"
"$INFRA/scripts/tf.sh" bootstrap apply -auto-approve -input=false -state=/infra/sim/.state/bootstrap.tfstate |
  grep -E "Apply complete|state_bucket ="
rm -f "$INFRA/bootstrap/zz_sim_override.tf"

secrets="$(mktemp)"
printf 'NVIDIA_API_KEYS=sim-nvidia-key\nGROQ_API_KEYS=sim-groq-key\n' > "$secrets"

for option in "${OPTIONS[@]}"; do
  step "$option: first deploy must stop at the secrets check"
  if "$INFRA/scripts/deploy.sh" "$option" > "$HERE/.state/$option-first.log" 2>&1; then
    echo "FAIL: deploy went past unset secrets"; exit 1
  fi
  grep -q "still unset" "$HERE/.state/$option-first.log" || { tail -30 "$HERE/.state/$option-first.log"; exit 1; }
  echo "ok: stopped and asked for the secrets"

  step "$option: set secrets, deploy again"
  "$INFRA/scripts/set-secrets.sh" "$secrets"
  "$INFRA/scripts/deploy.sh" "$option" | tee "$HERE/.state/$option-deploy.log" | grep -E "^==>|plan check|Apply complete|built|\[sim\]"

  tag="$(git -C "$INFRA" rev-parse --short=12 HEAD)"
  step "$option: run it"
  if [ "$option" = "ecs" ]; then python3 "$HERE/run_task_defs.py"; else "$HERE/smoke.sh" "$tag"; fi

  step "$option: a second plan deletes and replaces nothing"
  "$INFRA/scripts/deploy.sh" "$option" --plan | grep -E "plan check|Plan:|No changes"
done

rm -f "$secrets"
step "simulation passed: ${OPTIONS[*]}"
