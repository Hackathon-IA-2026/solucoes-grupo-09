variable "region" {
  description = "AWS region."
  type        = string
  default     = "us-east-1"
}

variable "name" {
  description = "Prefix for every resource name."
  type        = string
  default     = "wattsteer"
}

variable "image_tag" {
  description = "Tag of the images to run. scripts/deploy.sh sets it to the git commit."
  type        = string
  default     = "latest"
}

variable "certificate_arn" {
  description = "ACM certificate for HTTPS on the load balancer. Empty serves HTTP only."
  type        = string
  default     = ""
}

variable "public_url" {
  description = "The address readers use (https://… with a domain, empty to use the load balancer's DNS name)."
  type        = string
  default     = ""
}

variable "enable_voice" {
  description = "Pass XAI_API_KEY to the API. Leave false unless the key is set."
  type        = bool
  default     = false
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.small"
}

variable "db_allocated_storage" {
  description = "GB. Railway's Postgres volume is 50 GB."
  type        = number
  default     = 50
}

variable "cache_node_type" {
  type    = string
  default = "cache.t4g.micro"
}

variable "desired_count" {
  description = "Tasks per service. 0 stops every service without deleting anything."
  type        = number
  default     = 1
}
