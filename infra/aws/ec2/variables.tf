variable "region" {
  description = "AWS region."
  type        = string
  default     = "us-east-1"
}

variable "name" {
  description = "Prefix for every resource name. Not the ecs option's, so both can live in one account."
  type        = string
  default     = "wattsteer-ec2"
}

variable "image_tag" {
  description = "Tag of the images to run. scripts/deploy.sh sets it to the git commit."
  type        = string
  default     = "latest"
}

variable "instance_type" {
  description = "Graviton (arm64), like the images. t4g.xlarge is 4 vCPU and 16 GB."
  type        = string
  default     = "t4g.xlarge"
}

variable "data_volume_gb" {
  description = "The disk that holds Postgres, Redis, the ML artifacts and the RAG store."
  type        = number
  default     = 100
}

variable "site_address" {
  description = "What Caddy serves: a domain (e.g. wattsteer.example.com, with automatic HTTPS) or empty for plain HTTP on the instance's public IP."
  type        = string
  default     = ""
}
