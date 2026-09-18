output "public_url" {
  description = "Where the site answers. The web image is built with this as its API address."
  value       = local.public_url
}

output "repository_urls" {
  value = module.registry.repository_urls
}

output "cluster" {
  value = aws_ecs_cluster.this.name
}

output "services" {
  value = keys(local.services)
}

output "migrate_task_definition" {
  value = aws_ecs_task_definition.migrate.arn
}

output "task_subnets" {
  value = module.network.public_subnet_ids
}

output "task_security_group" {
  value = aws_security_group.tasks.id
}

output "parameter_prefix" {
  value = module.storage.parameter_prefix
}
