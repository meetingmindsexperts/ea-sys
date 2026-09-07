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

variable "uploads_bucket_name" {
  description = "Primary uploads bucket (ap-south-1). Since 2026-09-07 the app serves uploaded files from here (MAINT-002); the DR box reads and writes it cross-region during a failover, so its role needs access or every photo is AccessDenied."
  type        = string
  default     = "ea-sys-uploads"
}

variable "uploads_kms_key_arn" {
  description = "Customer-managed KMS key encrypting the uploads bucket (alias/ea-sys-uploads, ap-south-1). Its key policy delegates to IAM through the account-root statement, so granting these actions here is sufficient; no key-policy edit."
  type        = string
  default     = "arn:aws:kms:ap-south-1:803726282629:key/3371fc94-b72a-486e-8b57-bcff57474783"
}

variable "http_allow_cidrs" {
  description = "CIDRs allowed to reach ports 80/443 on the DR box. Default is wide-open (matches Mumbai's direct-exposure posture — no CDN/proxy in front). Tighten to an allowlist if you ever add one."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}
