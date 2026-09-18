terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.90"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # Filled by `-backend-config=backend.hcl` (see README): the bucket and lock
  # table `bootstrap/` created. Partial configuration keeps account ids out of
  # the repository.
  backend "s3" {}
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = var.name
      ManagedBy = "terraform"
      Option    = "ecs"
    }
  }
}
