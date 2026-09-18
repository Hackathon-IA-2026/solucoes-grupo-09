variable "name" {
  description = "Prefix for every resource name, e.g. wattsteer."
  type        = string
}

variable "cidr_block" {
  description = "The VPC's address range."
  type        = string
  default     = "10.40.0.0/16"
}
