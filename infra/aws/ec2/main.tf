# The fallback option: one Graviton instance running the same containers with
# Docker Compose (infra/aws/compose/compose.aws.yml), the way Railway runs
# them next to a Postgres and a Redis container with volumes.
#
# Use it when the event's account does not allow ECS, RDS or ElastiCache. It
# needs only EC2, EBS, S3, ECR, IAM and SSM.
#
# There is no SSH: the instance is managed through SSM (Session Manager for a
# shell, Run Command for deploys), so no key pair exists and port 22 is closed.

module "network" {
  source = "../modules/network"
  name   = var.name
}

module "registry" {
  source = "../modules/registry"
  name   = var.name
}

module "storage" {
  source = "../modules/storage"
  name   = var.name
}

data "aws_caller_identity" "current" {}

# Amazon Linux 2023 for arm64, from AWS's own public parameter, so the image is
# current without hard-coding an id per region.
data "aws_ssm_parameter" "al2023_arm64" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

resource "aws_security_group" "instance" {
  name        = "${var.name}-instance"
  description = "HTTP and HTTPS in; everything out"
  vpc_id      = module.network.vpc_id

  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# --- what the instance may do ------------------------------------------------

data "aws_iam_policy_document" "assume_ec2" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "instance" {
  name               = "${var.name}-instance"
  assume_role_policy = data.aws_iam_policy_document.assume_ec2.json
}

# Session Manager and Run Command.
resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.instance.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy_attachment" "ecr_read" {
  role       = aws_iam_role.instance.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
}

resource "aws_iam_role_policy" "instance" {
  name = "deploy-inputs"
  role = aws_iam_role.instance.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadSecrets"
        Effect   = "Allow"
        Action   = ["ssm:GetParametersByPath", "ssm:GetParameters"]
        Resource = "arn:aws:ssm:${var.region}:${data.aws_caller_identity.current.account_id}:parameter/${var.name}/*"
      },
      {
        Sid      = "ReadComposeFile"
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = "${module.storage.archive_bucket_arn}/deploy/*"
      },
    ]
  })
}

resource "aws_iam_instance_profile" "instance" {
  name = "${var.name}-instance"
  role = aws_iam_role.instance.name
}

# --- the instance and its data disk -----------------------------------------

resource "aws_instance" "this" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.value
  instance_type          = var.instance_type
  subnet_id              = module.network.public_subnet_ids[0]
  vpc_security_group_ids = [aws_security_group.instance.id]
  iam_instance_profile   = aws_iam_instance_profile.instance.name

  root_block_device {
    volume_size = 30
    volume_type = "gp3"
    encrypted   = true
  }

  metadata_options {
    http_tokens = "required"
  }

  user_data = templatefile("${path.module}/user-data.sh", {
    region      = var.region
    name        = var.name
    bucket      = module.storage.archive_bucket
    data_device = "/dev/sdf"
  })

  lifecycle {
    # A new AMI release must not replace a running instance on the next apply;
    # moving to a newer image is a deliberate step (see README).
    ignore_changes = [ami, user_data]
  }

  tags = { Name = var.name }
}

# Everything that must survive the instance lives here, on its own volume.
resource "aws_ebs_volume" "data" {
  availability_zone = aws_instance.this.availability_zone
  size              = var.data_volume_gb
  type              = "gp3"
  encrypted         = true

  lifecycle {
    prevent_destroy = true
  }

  tags = { Name = "${var.name}-data" }
}

resource "aws_volume_attachment" "data" {
  device_name = "/dev/sdf"
  volume_id   = aws_ebs_volume.data.id
  instance_id = aws_instance.this.id
}

# A fixed public address, so the site's URL (and the API address baked into
# the web image) does not change when the instance restarts.
resource "aws_eip" "this" {
  instance = aws_instance.this.id
  domain   = "vpc"
}

# --- what the instance runs ----------------------------------------------------

# The Postgres container's password, generated once and kept in SSM next to
# the other secrets; up.sh hands it to compose.
resource "random_password" "postgres" {
  length  = 32
  special = false
}

resource "aws_ssm_parameter" "postgres_password" {
  name  = "/${var.name}/POSTGRES_PASSWORD"
  type  = "SecureString"
  value = random_password.postgres.result
}

locals {
  public_url = var.site_address != "" ? "https://${var.site_address}" : "http://${aws_eip.this.public_ip}"
}

# The compose file and the non-secret settings, read by /opt/wattsteer/up.sh on
# every deploy. Secrets are read from SSM by the same script.
resource "aws_s3_object" "compose" {
  bucket = module.storage.archive_bucket
  key    = "deploy/compose.yml"
  source = "${path.module}/../compose/compose.aws.yml"
  etag   = filemd5("${path.module}/../compose/compose.aws.yml")
}

resource "aws_s3_object" "up" {
  bucket = module.storage.archive_bucket
  key    = "deploy/up.sh"
  source = "${path.module}/../compose/up.sh"
  etag   = filemd5("${path.module}/../compose/up.sh")
}

resource "aws_s3_object" "caddyfile" {
  bucket = module.storage.archive_bucket
  key    = "deploy/Caddyfile"
  source = "${path.module}/../compose/Caddyfile"
  etag   = filemd5("${path.module}/../compose/Caddyfile")
}

resource "aws_s3_object" "settings" {
  bucket = module.storage.archive_bucket
  key    = "deploy/settings.env"
  content = join("\n", [
    "REGISTRY=${split("/", module.registry.repository_urls["api"])[0]}",
    "NAME=${var.name}",
    "PUBLIC_URL=${local.public_url}",
    "SITE_ADDRESS=${var.site_address != "" ? var.site_address : ":80"}",
    "WATTSTEER_ARCHIVE_BUCKET=${module.storage.archive_bucket}",
    "WATTSTEER_ARCHIVE_REGION=${var.region}",
    "WATTSTEER_ARCHIVE_ENDPOINT=https://s3.${var.region}.amazonaws.com",
    "",
  ])
}
