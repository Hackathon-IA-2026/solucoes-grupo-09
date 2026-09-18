# Simulation only: the state bucket `bootstrap/` creates, on Moto.
# The real one is infra/aws/backend.hcl, written from backend.hcl.example.
bucket       = "wattsteer-tfstate-123456789012"
region       = "us-east-1"
use_lockfile = true

access_key                  = "test"
secret_key                  = "test"
skip_credentials_validation = true
skip_requesting_account_id  = true
skip_metadata_api_check     = true
skip_region_validation      = true
use_path_style              = true

endpoints = {
  s3  = "http://moto:5000"
  sts = "http://moto:5000"
}
