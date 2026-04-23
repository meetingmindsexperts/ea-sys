terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
  }
}

provider "aws" {
  region = var.region
}

provider "cloudflare" {}

data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"]

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-jammy-22.04-amd64-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

data "cloudflare_ip_ranges" "cloudflare" {}

data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "dr_s3_read" {
  statement {
    actions   = ["s3:GetObject", "s3:ListBucket"]
    resources = [
      "arn:aws:s3:::${var.dr_bucket_name}",
      "arn:aws:s3:::${var.dr_bucket_name}/*",
    ]
  }

  statement {
    actions   = ["kms:Decrypt"]
    resources = [var.dr_kms_key_arn]
  }
}

resource "aws_iam_role" "dr" {
  name               = "ea-sys-dr-singapore-role"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
  tags               = local.tags
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.dr.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "dr_s3_read" {
  name   = "dr-s3-read"
  role   = aws_iam_role.dr.id
  policy = data.aws_iam_policy_document.dr_s3_read.json
}

resource "aws_iam_instance_profile" "dr" {
  name = "ea-sys-dr-singapore-profile"
  role = aws_iam_role.dr.name
}

resource "aws_security_group" "dr" {
  name        = "ea-sys-dr-singapore-sg"
  description = "DR: 80/443 from Cloudflare only. No port 22 (SSM for shell)."

  # HTTPS from Cloudflare ranges only
  dynamic "ingress" {
    for_each = data.cloudflare_ip_ranges.cloudflare.cidr_blocks
    content {
      description = "Cloudflare HTTPS"
      from_port   = 443
      to_port     = 443
      protocol    = "tcp"
      cidr_blocks = [ingress.value]
    }
  }

  # HTTP from Cloudflare ranges only (ACME HTTP-01 + redirects)
  dynamic "ingress" {
    for_each = data.cloudflare_ip_ranges.cloudflare.cidr_blocks
    content {
      description = "Cloudflare HTTP"
      from_port   = 80
      to_port     = 80
      protocol    = "tcp"
      cidr_blocks = [ingress.value]
    }
  }

  # No SSH ingress. Shell access is via `aws ssm start-session`.

  egress {
    description      = "All outbound (Supabase, Zoom, Stripe, Brevo, SSM, GitHub, etc.)"
    from_port        = 0
    to_port          = 0
    protocol         = "-1"
    cidr_blocks      = ["0.0.0.0/0"]
    ipv6_cidr_blocks = ["::/0"]
  }

  tags = local.tags
}

resource "aws_instance" "dr" {
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.instance_type
  vpc_security_group_ids = [aws_security_group.dr.id]
  iam_instance_profile   = aws_iam_instance_profile.dr.name

  user_data_replace_on_change = true
  user_data = templatefile("${path.module}/user-data.sh", {
    git_ref        = var.git_ref
    github_repo    = var.github_repo
    dr_bucket_name = var.dr_bucket_name
    region         = var.region
  })

  root_block_device {
    volume_size           = var.root_volume_size_gb
    volume_type           = "gp3"
    encrypted             = true
    delete_on_termination = true
  }

  # Fail fast if instance can't resolve IMDS — cheap hedge against bad AMI updates.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 2
  }

  tags = merge(local.tags, { Name = "ea-sys-dr-singapore" })
}

resource "aws_eip" "dr" {
  instance = aws_instance.dr.id
  domain   = "vpc"
  tags     = merge(local.tags, { Name = "ea-sys-dr-singapore-eip" })
}

locals {
  tags = {
    Project     = "ea-sys"
    Environment = "dr"
    ManagedBy   = "terraform"
    Module      = "infra/dr"
  }
}
