#!/usr/bin/env bash
# Create or update the WattSteer stack (stack.yaml) in the event's account.
#
#   infra/aws/stack.sh
#
# Needs the Workshop Studio credentials exported (AWS_ACCESS_KEY_ID,
# AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN; "Get AWS CLI credentials" on the
# event page). Run it when stack.yaml changes; a code change needs deploy.sh.
#
# The participant role may not pass a role to CloudFormation, so this assumes
# the account's CDK deploy role and hands CloudFormation the CDK execution role,
# which is what `cdk deploy` does. The account allows exactly that chain.
#
# Writes stack.env, the outputs deploy.sh and the GitHub workflow read. Commit
# it: it names resources, not secrets.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
HERE="$ROOT/infra/aws"
AWS="$HERE/scripts/aws.sh"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-us-west-2}"
STACK="${WATTSTEER_STACK:-wattsteer}"

account="$("$AWS" sts get-caller-identity --query Account --output text)"
qualifier="${CDK_QUALIFIER:-hnb659fds}"
deploy_role="arn:aws:iam::$account:role/cdk-$qualifier-deploy-role-$account-$AWS_DEFAULT_REGION"
exec_role="arn:aws:iam::$account:role/cdk-$qualifier-cfn-exec-role-$account-$AWS_DEFAULT_REGION"

# The default VPC and one of its public subnets: the instance needs an address
# CloudFront can reach, and the participant may describe both.
# shellcheck disable=SC2016 # the backticks are JMESPath literals
vpc="$("$AWS" ec2 describe-vpcs --filters Name=is-default,Values=true \
  --query 'Vpcs[0].VpcId' --output text)"
# shellcheck disable=SC2016
subnet="${WATTSTEER_SUBNET:-$("$AWS" ec2 describe-subnets \
  --filters "Name=vpc-id,Values=$vpc" Name=map-public-ip-on-launch,Values=true \
  --query 'sort_by(Subnets,&AvailabilityZone)[1].SubnetId' --output text)}"

echo "== assuming the CDK deploy role"
read -r key secret token < <("$AWS" sts assume-role --role-arn "$deploy_role" \
  --role-session-name "wattsteer-stack" \
  --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' --output text)

# The provider exists once per account: make it only if nobody has.
provider=true
if "$AWS" iam get-open-id-connect-provider --open-id-connect-provider-arn \
  "arn:aws:iam::$account:oidc-provider/token.actions.githubusercontent.com" >/dev/null 2>&1; then
  if ! "$AWS" cloudformation describe-stack-resource --stack-name "$STACK" \
    --logical-resource-id GitHubProvider >/dev/null 2>&1; then
    provider=false
  fi
fi

echo "== deploying $STACK (vpc $vpc, subnet $subnet)"
AWS_ACCESS_KEY_ID="$key" AWS_SECRET_ACCESS_KEY="$secret" AWS_SESSION_TOKEN="$token" \
  AWS_WORKDIR="$HERE" "$AWS" cloudformation deploy \
  --stack-name "$STACK" --template-file stack.yaml \
  --role-arn "$exec_role" --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset \
  --parameter-overrides "VpcId=$vpc" "SubnetId=$subnet" "CreateGitHubProvider=$provider"

echo "== outputs"
"$AWS" cloudformation describe-stacks --stack-name "$STACK" \
  --query 'Stacks[0].Outputs[].[OutputKey,OutputValue]' --output text |
  python3 -c '
import re, sys
print("# Written by infra/aws/stack.sh from the stack outputs. Names, not secrets.")
print("AWS_REGION=" + sys.argv[1])
print("STACK=" + sys.argv[2])
for line in sys.stdin:
    key, value = line.split()
    print(re.sub(r"(?<=[a-z])(?=[A-Z])", "_", key).upper() + "=" + value)
' "$AWS_DEFAULT_REGION" "$STACK" > "$HERE/stack.env"
cat "$HERE/stack.env"
