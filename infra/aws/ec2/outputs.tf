output "public_url" {
  description = "Where the site answers. The web image is built with this as its API address."
  value       = local.public_url
}

output "repository_urls" {
  value = module.registry.repository_urls
}

output "instance_id" {
  value = aws_instance.this.id
}

output "public_ip" {
  value = aws_eip.this.public_ip
}

output "deploy_bucket" {
  value = module.storage.archive_bucket
}

output "parameter_prefix" {
  value = module.storage.parameter_prefix
}
