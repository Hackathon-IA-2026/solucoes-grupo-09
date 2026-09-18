# The five Railway services as ECS Fargate services, one task each.
#
# Each entry in `local.services` is what `.railway/railway.ts` and the Railway
# dashboard say about that service: image, start command, port, health check,
# volume, environment. They are written once, as data, and one task definition
# and one service block turn every entry into AWS resources.

resource "aws_ecs_cluster" "this" {
  name = var.name

  setting {
    name  = "containerInsights"
    value = "disabled"
  }
}

# Private DNS, so the gateway reaches `ml` and `rag` by name the way Railway's
# private network does (`http://ml.wattsteer.internal:8000`).
resource "aws_service_discovery_private_dns_namespace" "this" {
  name = "${var.name}.internal"
  vpc  = module.network.vpc_id
}

locals {
  internal = aws_service_discovery_private_dns_namespace.this.name
  secrets  = merge(module.storage.secret_arns, { DATABASE_URL = aws_ssm_parameter.database_url.arn })

  gateway_env = {
    NODE_ENV                         = "production"
    REDIS_URL                        = local.redis_url
    WATTSTEER_ML_URL                 = "http://ml.${local.internal}:8000"
    WATTSTEER_RAG_URL                = "http://rag.${local.internal}:8082"
    WATTSTEER_ARCHIVE_BUCKET         = module.storage.archive_bucket
    WATTSTEER_ARCHIVE_REGION         = var.region
    WATTSTEER_ARCHIVE_ENDPOINT       = "https://s3.${var.region}.amazonaws.com"
    WATTSTEER_ARCHIVE_RETENTION_DAYS = "90"
  }
  gateway_secrets = concat(
    ["DATABASE_URL", "WATTSTEER_ARCHIVE_ACCESS_KEY_ID", "WATTSTEER_ARCHIVE_SECRET_ACCESS_KEY", "WATTSTEER_RAG_ACCESS_TOKEN"],
    var.enable_voice ? ["XAI_API_KEY"] : [],
  )

  services = {
    web = {
      image   = "web"
      command = null
      port    = 8080
      cpu     = 256
      memory  = 512
      env     = { NODE_ENV = "production", PORT = "8080" }
      secrets = {}
      volume  = null
      lb      = aws_lb_target_group.web.arn
    }
    api = {
      image   = "api"
      command = null
      port    = 3000
      cpu     = 512
      memory  = 1024
      env = merge(local.gateway_env, {
        PORT                          = "3000"
        WATTSTEER_ROLE                = "api"
        WATTSTEER_CORS_ORIGINS        = local.public_url
        WATTSTEER_PUBLIC_URL          = local.public_url
        WATTSTEER_TRUSTED_PROXY_DEPTH = "1"
      })
      secrets = { for key in local.gateway_secrets : key => local.secrets[key] }
      volume  = null
      lb      = aws_lb_target_group.api.arn
    }
    worker = {
      image   = "api"
      command = ["bun", "run", "src/worker.ts"]
      port    = null
      cpu     = 512
      memory  = 1024
      env     = merge(local.gateway_env, { WATTSTEER_ROLE = "worker" })
      secrets = { for key in local.gateway_secrets : key => local.secrets[key] }
      volume  = null
      lb      = null
    }
    ml = {
      image   = "ml"
      command = ["wattsteer-ml"]
      port    = 8000
      cpu     = 1024
      memory  = 4096
      env = {
        PORT                      = "8000"
        WATTSTEER_ML_ENV          = "production"
        WATTSTEER_ML_ARTIFACT_DIR = "/data/models"
      }
      secrets = { DATABASE_URL = local.secrets.DATABASE_URL }
      volume  = { name = "ml-models", path = "/data/models" }
      lb      = null
    }
    rag = {
      image   = "rag"
      command = null
      port    = 8082
      cpu     = 1024
      memory  = 2048
      env = {
        WATTSTEER_RAG_STORE_DIR       = "/data/rag-store"
        WATTSTEER_RAG_MIGRATE_ON_BOOT = "1"
        # Builds the normative corpus on the first boot; later boots find the
        # documents already stored and skip them.
        WATTSTEER_RAG_INDEX_ON_BOOT = "1"
      }
      secrets = {
        WATTSTEER_RAG_DATABASE_URL = local.secrets.DATABASE_URL
        WATTSTEER_RAG_ACCESS_TOKEN = local.secrets.WATTSTEER_RAG_ACCESS_TOKEN
        NVIDIA_API_KEYS            = local.secrets.NVIDIA_API_KEYS
        GROQ_API_KEYS              = local.secrets.GROQ_API_KEYS
      }
      volume = { name = "rag-store", path = "/data/rag-store" }
      lb     = null
    }
  }
}

# --- permissions -------------------------------------------------------------

data "aws_iam_policy_document" "assume_ecs_tasks" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# The execution role pulls images, writes logs and reads the secrets it injects.
resource "aws_iam_role" "execution" {
  name               = "${var.name}-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.assume_ecs_tasks.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "execution_secrets" {
  name = "read-secrets"
  role = aws_iam_role.execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["ssm:GetParameters"]
      Resource = values(local.secrets)
    }]
  })
}

# The task role is what the code itself runs as. It needs nothing but the
# volumes: the archive uses its own key pair (see modules/storage).
resource "aws_iam_role" "task" {
  name               = "${var.name}-ecs-task"
  assume_role_policy = data.aws_iam_policy_document.assume_ecs_tasks.json
}

resource "aws_iam_role_policy" "task_efs" {
  name = "mount-volumes"
  role = aws_iam_role.task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["elasticfilesystem:ClientMount", "elasticfilesystem:ClientWrite"]
      Resource = aws_efs_file_system.this.arn
    }]
  })
}

resource "aws_cloudwatch_log_group" "service" {
  for_each          = toset(concat(keys(local.services), ["migrate"]))
  name              = "/${var.name}/${each.key}"
  retention_in_days = 14
}

# --- one task definition and one service per entry ---------------------------

resource "aws_ecs_task_definition" "service" {
  for_each                 = local.services
  family                   = "${var.name}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = each.value.cpu
  memory                   = each.value.memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  # Graviton: the images are built on arm64 (the team's Macs and the CI's arm
  # runners), and ARM Fargate is the cheaper of the two.
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

  container_definitions = jsonencode([{
    name      = each.key
    image     = "${module.registry.repository_urls[each.value.image]}:${var.image_tag}"
    essential = true
    command   = each.value.command
    portMappings = each.value.port == null ? [] : [{
      containerPort = each.value.port
      protocol      = "tcp"
    }]
    environment = [for key, value in each.value.env : { name = key, value = value }]
    secrets     = [for key, arn in each.value.secrets : { name = key, valueFrom = arn }]
    mountPoints = each.value.volume == null ? [] : [{
      sourceVolume  = each.value.volume.name
      containerPath = each.value.volume.path
    }]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.service[each.key].name
        awslogs-region        = var.region
        awslogs-stream-prefix = each.key
      }
    }
  }])

  dynamic "volume" {
    for_each = each.value.volume == null ? [] : [each.value.volume]
    content {
      name = volume.value.name
      efs_volume_configuration {
        file_system_id     = aws_efs_file_system.this.id
        transit_encryption = "ENABLED"
        authorization_config {
          access_point_id = aws_efs_access_point.volume[volume.value.name].id
          iam             = "ENABLED"
        }
      }
    }
  }
}

resource "aws_service_discovery_service" "service" {
  for_each = { for name, s in local.services : name => s if s.port != null }
  name     = each.key

  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.this.id
    dns_records {
      type = "A"
      ttl  = 10
    }
  }
}

resource "aws_ecs_service" "service" {
  for_each        = local.services
  name            = each.key
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.service[each.key].arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  # Railway's "restart on failure": a task that dies is replaced, and a deploy
  # that never becomes healthy rolls back instead of leaving the service down.
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = module.network.public_subnet_ids
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = true
  }

  dynamic "load_balancer" {
    for_each = each.value.lb == null ? [] : [each.value.lb]
    content {
      target_group_arn = load_balancer.value
      container_name   = each.key
      container_port   = each.value.port
    }
  }

  dynamic "service_registries" {
    for_each = each.value.port == null ? [] : [1]
    content {
      registry_arn = aws_service_discovery_service.service[each.key].arn
    }
  }

  health_check_grace_period_seconds = each.value.lb == null ? null : 120

  depends_on = [aws_lb_listener.http, aws_efs_mount_target.this]
}

# --- the migration, run once per deploy by scripts/deploy.sh ----------------
#
# Railway applies migrations out of band (apps/api/src/api/index.ts says so),
# and the API image carries no migration files. This task runs the repo's own
# `drizzle-kit migrate` from infra/aws/docker/migrate.Dockerfile, inside the
# VPC, where the database is reachable.

resource "aws_ecs_task_definition" "migrate" {
  family                   = "${var.name}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

  container_definitions = jsonencode([{
    name      = "migrate"
    image     = "${module.registry.repository_urls["migrate"]}:${var.image_tag}"
    essential = true
    secrets   = [{ name = "DATABASE_URL", valueFrom = local.secrets.DATABASE_URL }]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.service["migrate"].name
        awslogs-region        = var.region
        awslogs-stream-prefix = "migrate"
      }
    }
  }])
}
