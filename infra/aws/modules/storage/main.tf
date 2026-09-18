# What outlives any deploy: the raw-payload archive and the secrets.
#
# The archive is the bucket Railway provides as `wattsteer-archive`. The API
# talks to it through Bun's S3 client with an access key pair
# (`apps/api/src/ingest/archive.ts`), so the key pair is created here rather
# than changing the code to read a task role.
#
# Secrets are SSM SecureString parameters named after the environment variable
# they fill, under `/<name>/`. The ones a person provides (provider keys) are
# created with a placeholder and never written again by Terraform
# (`ignore_changes`), so their values stay out of the Terraform state and a
# re-apply cannot overwrite what `scripts/set-secrets.sh` put there.

variable "name" {
  description = "Prefix for every resource name, e.g. wattsteer."
  type        = string
}

variable "operator_secrets" {
  description = "Secrets a person sets with scripts/set-secrets.sh, by environment variable name."
  type        = list(string)
  default = [
    "NVIDIA_API_KEYS",
    "GROQ_API_KEYS",
    "XAI_API_KEY",
    "EXPO_PUBLIC_CESIUM_ION_TOKEN",
  ]
}

data "aws_caller_identity" "current" {}

resource "aws_s3_bucket" "archive" {
  # The account id keeps the name globally unique without a random suffix
  # that would change the bucket on every fresh state.
  bucket = "${var.name}-archive-${data.aws_caller_identity.current.account_id}"

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "archive" {
  bucket = aws_s3_bucket.archive.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "archive" {
  bucket                  = aws_s3_bucket.archive.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "archive" {
  bucket = aws_s3_bucket.archive.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_iam_user" "archive" {
  name = "${var.name}-archive"
}

resource "aws_iam_user_policy" "archive" {
  name = "archive-bucket"
  user = aws_iam_user.archive.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"]
      Resource = [aws_s3_bucket.archive.arn, "${aws_s3_bucket.archive.arn}/*"]
    }]
  })
}

resource "aws_iam_access_key" "archive" {
  user = aws_iam_user.archive.name
}

resource "random_password" "rag_token" {
  length  = 40
  special = false
}

resource "aws_ssm_parameter" "operator" {
  for_each = toset(var.operator_secrets)
  name     = "/${var.name}/${each.key}"
  type     = "SecureString"
  value    = "unset"

  lifecycle {
    ignore_changes = [value]
  }
}

# Values Terraform itself creates, so they are written on every apply.
locals {
  generated = {
    WATTSTEER_ARCHIVE_ACCESS_KEY_ID     = aws_iam_access_key.archive.id
    WATTSTEER_ARCHIVE_SECRET_ACCESS_KEY = aws_iam_access_key.archive.secret
    WATTSTEER_RAG_ACCESS_TOKEN          = random_password.rag_token.result
  }
}

resource "aws_ssm_parameter" "generated" {
  for_each = nonsensitive(toset(keys(local.generated)))
  name     = "/${var.name}/${each.key}"
  type     = "SecureString"
  value    = local.generated[each.key]
}

output "archive_bucket" {
  value = aws_s3_bucket.archive.bucket
}

output "archive_bucket_arn" {
  value = aws_s3_bucket.archive.arn
}

output "secret_arns" {
  description = "Environment variable name → SSM parameter ARN, for every secret."
  value = merge(
    { for key, p in aws_ssm_parameter.operator : key => p.arn },
    { for key, p in aws_ssm_parameter.generated : key => p.arn },
  )
}

output "parameter_prefix" {
  value = "/${var.name}/"
}
