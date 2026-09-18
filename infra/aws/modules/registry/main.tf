# One image repository per image the deploy builds. `worker` has none of its
# own: it runs the `api` image with another command, exactly as on Railway.

variable "name" {
  description = "Prefix for every repository, e.g. wattsteer."
  type        = string
}

variable "images" {
  description = "The images the deploy builds and pushes."
  type        = list(string)
  default     = ["api", "ml", "web", "rag", "migrate"]
}

resource "aws_ecr_repository" "this" {
  for_each             = toset(var.images)
  name                 = "${var.name}/${each.key}"
  image_tag_mutability = "MUTABLE"

  # A repository with images in it is refused on delete. `force_delete` would
  # turn a mistyped `destroy` into lost releases.
  force_delete = false

  image_scanning_configuration {
    scan_on_push = true
  }
}

# Keeps the last twenty images, so a rollback target always exists and storage
# does not grow without bound.
resource "aws_ecr_lifecycle_policy" "this" {
  for_each   = aws_ecr_repository.this
  repository = each.value.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the last 20 images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 20
      }
      action = { type = "expire" }
    }]
  })
}

output "repository_urls" {
  description = "Image name → repository URL."
  value       = { for image, repo in aws_ecr_repository.this : image => repo.repository_url }
}

output "repository_arns" {
  value = [for repo in aws_ecr_repository.this : repo.arn]
}
