# The shared modules, and the data stores this option runs on managed
# services: Postgres on RDS, Redis on ElastiCache, the two volumes on EFS.
#
# Railway runs two Postgres databases (the main one and the RAG's, which needs
# pgvector). RDS Postgres ships pgvector, and `apps/rag` keeps everything in its
# own `rag` schema, so here both point at one database. Nothing in the code
# changes; only WATTSTEER_RAG_DATABASE_URL does.

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

# --- security groups: internet → alb → tasks → data -------------------------

resource "aws_security_group" "alb" {
  name        = "${var.name}-alb"
  description = "Public HTTP(S) to the load balancer"
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

resource "aws_security_group" "tasks" {
  name        = "${var.name}-tasks"
  description = "The containers: reachable from the load balancer and from each other"
  vpc_id      = module.network.vpc_id

  ingress {
    from_port       = 0
    to_port         = 65535
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  ingress {
    from_port = 0
    to_port   = 65535
    protocol  = "tcp"
    self      = true
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "data" {
  name        = "${var.name}-data"
  description = "Postgres, Redis and EFS, from the containers only"
  vpc_id      = module.network.vpc_id

  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.tasks.id]
  }

  ingress {
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.tasks.id]
  }

  ingress {
    from_port       = 2049
    to_port         = 2049
    protocol        = "tcp"
    security_groups = [aws_security_group.tasks.id]
  }
}

# --- Postgres --------------------------------------------------------------

resource "random_password" "db" {
  length  = 32
  special = false
}

resource "aws_db_subnet_group" "this" {
  name       = var.name
  subnet_ids = module.network.private_subnet_ids
}

resource "aws_db_instance" "this" {
  identifier            = var.name
  engine                = "postgres"
  engine_version        = "16"
  instance_class        = var.db_instance_class
  allocated_storage     = var.db_allocated_storage
  max_allocated_storage = var.db_allocated_storage * 2
  storage_encrypted     = true

  db_name  = "wattsteer"
  username = "wattsteer"
  password = random_password.db.result

  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.data.id]
  publicly_accessible    = false

  backup_retention_period = 7
  # The database holds everything ingested; losing it by accident is the one
  # mistake this deploy must not make easy.
  deletion_protection       = true
  skip_final_snapshot       = false
  final_snapshot_identifier = "${var.name}-final"

  lifecycle {
    prevent_destroy = true
  }
}

locals {
  database_url = "postgres://wattsteer:${random_password.db.result}@${aws_db_instance.this.address}:5432/wattsteer"
}

resource "aws_ssm_parameter" "database_url" {
  name  = "/${var.name}/DATABASE_URL"
  type  = "SecureString"
  value = local.database_url
}

# --- Redis -----------------------------------------------------------------

resource "aws_elasticache_subnet_group" "this" {
  name       = var.name
  subnet_ids = module.network.private_subnet_ids
}

resource "aws_elasticache_cluster" "this" {
  cluster_id         = var.name
  engine             = "redis"
  engine_version     = "7.1"
  node_type          = var.cache_node_type
  num_cache_nodes    = 1
  port               = 6379
  subnet_group_name  = aws_elasticache_subnet_group.this.name
  security_group_ids = [aws_security_group.data.id]
}

locals {
  redis_url = "redis://${aws_elasticache_cluster.this.cache_nodes[0].address}:6379"
}

# --- the two volumes: ML artifacts and the RAG document store ---------------

resource "aws_efs_file_system" "this" {
  creation_token = var.name
  encrypted      = true

  lifecycle {
    prevent_destroy = true
  }

  tags = { Name = var.name }
}

resource "aws_efs_mount_target" "this" {
  count           = 2
  file_system_id  = aws_efs_file_system.this.id
  subnet_id       = module.network.public_subnet_ids[count.index]
  security_groups = [aws_security_group.data.id]
}

# One access point per volume, so each service sees its own directory as `/`,
# the way a Railway volume looks to the service it is attached to.
resource "aws_efs_access_point" "volume" {
  for_each       = toset(["ml-models", "rag-store"])
  file_system_id = aws_efs_file_system.this.id

  root_directory {
    path = "/${each.key}"
    creation_info {
      owner_uid   = 10001
      owner_gid   = 10001
      permissions = "0755"
    }
  }
}
