# Simulation only, ecs/ root. Moto creates the ElastiCache cluster but returns
# no `cache_nodes`, which real AWS always does; the address is replaced by the
# simulation's own Redis so the rest of the plan can be exercised.
locals {
  redis_url = "redis://redis:6379"
}
