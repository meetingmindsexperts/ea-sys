variable "region" {
  description = "AWS region for the DR box."
  type        = string
  default     = "ap-southeast-1" # Singapore
}

variable "instance_type" {
  description = "EC2 instance type. Match or exceed the Mumbai prod box (currently t3.large)."
  type        = string
  default     = "t3.large"
}

variable "root_volume_size_gb" {
  description = "Root EBS volume size. Must fit the Docker image + node_modules + media."
  type        = number
  default     = 40
}

variable "git_ref" {
  description = "Git branch or tag to deploy. Default 'main' matches prod."
  type        = string
  default     = "main"
}

variable "github_repo" {
  description = "owner/repo on GitHub to clone from."
  type        = string
  default     = "meetingmindsexperts/ea-sys"
}

variable "dr_bucket_name" {
  description = "S3 bucket in the DR region holding the nightly .env snapshot."
  type        = string
  default     = "ea-sys-dr-singapore"
}

variable "dr_kms_key_arn" {
  description = "KMS key ARN encrypting objects in the DR bucket. Created alongside the bucket; not managed by this module."
  type        = string
}
