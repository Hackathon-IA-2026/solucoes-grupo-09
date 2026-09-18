# One load balancer for the site and the API, split by path.
#
# The web image bakes the API address in at build time (EXPO_PUBLIC_API_URL),
# so web and API on one origin means that address is simply the load
# balancer's own, known before the first image is built, with no CORS between
# them.

resource "aws_lb" "this" {
  name               = var.name
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = module.network.public_subnet_ids
  # Voice keeps a WebSocket open; the default 60 s would cut a pause short.
  idle_timeout = 300
}

resource "aws_lb_target_group" "web" {
  name        = "${var.name}-web"
  port        = 8080
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = module.network.vpc_id

  health_check {
    path    = "/healthz"
    matcher = "200"
  }
}

resource "aws_lb_target_group" "api" {
  name        = "${var.name}-api"
  port        = 3000
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = module.network.vpc_id

  health_check {
    path    = "/health"
    matcher = "200"
  }
}

locals {
  https = var.certificate_arn != ""
  # The gateway's own paths; everything else is the site. Five is the most one
  # rule accepts, and these are all of them (`/health` is the target group's).
  api_path = ["/v1/*", "/ready", "/ingest/*", "/docs", "/docs/*"]
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"

  # With a certificate, plain HTTP only redirects; without one, it serves.
  default_action {
    type             = local.https ? "redirect" : "forward"
    target_group_arn = local.https ? null : aws_lb_target_group.web.arn

    dynamic "redirect" {
      for_each = local.https ? [1] : []
      content {
        port        = "443"
        protocol    = "HTTPS"
        status_code = "HTTP_301"
      }
    }
  }
}

resource "aws_lb_listener" "https" {
  count             = local.https ? 1 : 0
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }
}

resource "aws_lb_listener_rule" "api" {
  listener_arn = local.https ? aws_lb_listener.https[0].arn : aws_lb_listener.http.arn
  priority     = 10

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }

  condition {
    path_pattern {
      values = local.api_path
    }
  }
}

locals {
  public_url = var.public_url != "" ? var.public_url : "http://${aws_lb.this.dns_name}"
}
