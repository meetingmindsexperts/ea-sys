output "public_ip" {
  description = "Elastic IP of the DR box. Point Cloudflare DNS here during promotion."
  value       = aws_eip.dr.public_ip
}

output "instance_id" {
  description = "Instance ID. Use with `aws ssm start-session --target <id> --region ap-southeast-1`."
  value       = aws_instance.dr.id
}

output "ssm_session_command" {
  description = "Copy-paste command to open a shell on the DR box."
  value       = "aws ssm start-session --target ${aws_instance.dr.id} --region ${var.region}"
}
