# Simulation only. `sim/simulate.sh` copies this file into a root as
# `zz_sim_override.tf` for the length of a run and deletes it afterwards;
# Terraform merges `*_override.tf` files into the configuration, so the real
# provider block is untouched and nothing here can reach a real account.
#
# Every AWS API call goes to Moto, an open-source AWS simulator, listening as
# `moto` on the simulation's Docker network. The account it answers for is
# 123456789012.

provider "aws" {
  region                      = "us-east-1"
  access_key                  = "test"
  secret_key                  = "test"
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  s3_use_path_style           = true

  endpoints {
    acm              = "http://moto:5000"
    cloudwatchlogs   = "http://moto:5000"
    ec2              = "http://moto:5000"
    ecr              = "http://moto:5000"
    ecs              = "http://moto:5000"
    efs              = "http://moto:5000"
    elasticache      = "http://moto:5000"
    elbv2            = "http://moto:5000"
    iam              = "http://moto:5000"
    rds              = "http://moto:5000"
    s3               = "http://moto:5000"
    s3control        = "http://moto:5000"
    servicediscovery = "http://moto:5000"
    ssm              = "http://moto:5000"
    sts              = "http://moto:5000"
  }
}
