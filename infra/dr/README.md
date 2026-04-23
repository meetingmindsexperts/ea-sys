# EA-SYS DR — Singapore break-glass box

Terraform module that provisions a replacement EA-SYS box in `ap-southeast-1`
when Mumbai is down. **No standing cost** — provision on demand, destroy after.

RTO target: **~10 minutes** from `terraform apply` to serving traffic.

## What's in here

| File | Purpose |
|---|---|
| `main.tf` | EC2 + EIP + SG + IAM in Singapore. SG allows 80/443 from Cloudflare only, no port 22. |
| `user-data.sh` | First-boot bootstrap. Installs Docker, clones the repo, fetches `.env` from S3, runs `scripts/deploy.sh`. |
| `variables.tf` | `region`, `instance_type`, `git_ref`, `github_repo`, `dr_bucket_name`, `dr_kms_key_arn`. |
| `outputs.tf` | `public_ip`, `instance_id`, `ssm_session_command`. |

## One-time setup (before first `terraform apply`)

You only need to do this once. Steps mirror §6a of the hardening plan.

### 1. Create the DR S3 bucket + KMS key in Singapore

```bash
# Customer-managed KMS key (do NOT reuse the Mumbai key)
aws kms create-key --region ap-southeast-1 \
  --description "EA-SYS DR bucket encryption" \
  --tags TagKey=Project,TagValue=ea-sys TagKey=Environment,TagValue=dr
# Note the KeyArn from output — pass as dr_kms_key_arn to Terraform.

# Bucket (name must be globally unique)
aws s3api create-bucket --bucket ea-sys-dr-singapore \
  --region ap-southeast-1 \
  --create-bucket-configuration LocationConstraint=ap-southeast-1

# Versioning + encryption + public-access block
aws s3api put-bucket-versioning --bucket ea-sys-dr-singapore \
  --versioning-configuration Status=Enabled

aws s3api put-bucket-encryption --bucket ea-sys-dr-singapore \
  --server-side-encryption-configuration '{
    "Rules":[{"ApplyServerSideEncryptionByDefault":{
      "SSEAlgorithm":"aws:kms",
      "KMSMasterKeyID":"<KEY_ARN_FROM_ABOVE>"
    }}]
  }'

aws s3api put-public-access-block --bucket ea-sys-dr-singapore \
  --public-access-block-configuration \
  "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"
```

### 2. Add `GITHUB_DR_TOKEN` to the Mumbai `.env`

The DR box clones the repo with this token on first boot. Create a
**fine-grained** GitHub PAT with `Contents: read` scoped to the
`meetingmindsexperts/ea-sys` repo only. **No other scopes.**

SSM into Mumbai and append to `.env`:

```bash
aws ssm start-session --target <mumbai-instance-id> --region ap-south-1
sudo -iu ubuntu
echo 'GITHUB_DR_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' >> /home/ubuntu/ea-sys/.env
```

Next `.env` cron run (02:30 IST) will ship it to Singapore.

### 3. Set up the Mumbai→Singapore nightly `.env` cron

On the Mumbai box (`sudo -iu ubuntu`, then `crontab -e`):

```cron
# Nightly .env snapshot to Singapore DR bucket (02:30 IST, after other backups)
30 2 * * * aws s3 cp /home/ubuntu/ea-sys/.env s3://ea-sys-dr-singapore/env/$(date +\%F).env --region ap-southeast-1 >> /home/ubuntu/cron-dr-backup.log 2>&1
```

This requires the Mumbai EC2's IAM role (`ea-sys-mumbai-ec2-role`) to have
`s3:PutObject` on `arn:aws:s3:::ea-sys-dr-singapore/*` and `kms:Encrypt` on the
Singapore KMS key — attach an inline policy when creating the role.

### 4. Create `terraform.tfvars`

Do NOT commit this file — it's in `.gitignore`.

```hcl
# infra/dr/terraform.tfvars
dr_kms_key_arn = "arn:aws:kms:ap-southeast-1:123456789012:key/..."
# All other vars have sensible defaults in variables.tf.
```

## Monthly drill (15th of each month, 5 min)

Validates that the bootstrap still works before you actually need it.

```bash
cd infra/dr
terraform init    # first time only
terraform apply -auto-approve

# Wait ~7 min total (4 min provisioning + 3 min user-data). Tail the log:
aws ssm start-session --target $(terraform output -raw instance_id) --region ap-southeast-1
# Inside the session:
sudo tail -f /var/log/ea-sys-bootstrap.log
# Expect: [bootstrap] complete

# Validate the app is serving
curl -kI "https://$(terraform output -raw public_ip)/api/health"
# Expect: HTTP/2 200  + body says database: connected

# Tear down
terraform destroy -auto-approve
```

If the drill fails, **do not destroy** — debug first. This is exactly the
moment you want to find problems, not during a real outage.

## Promotion runbook (real outage, Mumbai down)

1. **Confirm Mumbai is really down.**
   - AWS Health Dashboard for `ap-south-1`.
   - `aws ssm start-session --target <mumbai-id> --region ap-south-1` times out or errors.

2. **Provision the DR box.**
   ```bash
   cd infra/dr
   terraform apply -auto-approve
   # Takes ~7 min.
   ```

3. **Copy the new public IP.**
   ```bash
   terraform output public_ip
   ```

4. **Update Cloudflare DNS.**
   - Dashboard → DNS → `events` A record → replace value with the new IP.
   - Leave **Proxied (orange cloud)** on.
   - Propagation: ~30s through Cloudflare.

5. **Verify traffic is serving.**
   ```bash
   curl -I https://events.meetingmindsgroup.com/api/health
   # Expect: 200, database: connected
   ```
   Check Cloudflare Analytics → traffic moving from Mumbai origin to Singapore origin.

6. **Issue a proper TLS cert** (the bootstrap uses a self-signed cert for the
   break-glass window — Cloudflare Full(strict) accepts it short-term because
   CF validates cert-expiry but not CN match exactly; however, swap ASAP):
   ```bash
   aws ssm start-session --target $(terraform output -raw instance_id) --region ap-southeast-1
   sudo certbot --nginx -d events.meetingmindsgroup.com \
     --non-interactive --agree-tos -m <your-email>
   ```

7. **Monitor for 15 min.** Check `/api/health`, /logs viewer, Sentry.

## Post-incident: returning to Mumbai

1. Mumbai region is healthy again and your Mumbai box either recovered or
   was rebuilt from the Mumbai EBS snapshot.
2. **Cloudflare DNS** → `events` A record → point back at the Mumbai EIP.
3. Verify: `curl -I https://events.meetingmindsgroup.com/api/health` + confirm
   Cloudflare analytics show traffic hitting Mumbai origin again.
4. `cd infra/dr && terraform destroy -auto-approve` — kills the Singapore box.
5. **Check for data drift.** During the outage any uploads (`public/uploads/*`)
   landed on the Singapore EBS volume. Those are **lost** when you
   `terraform destroy`. This is the known gap — see the follow-up to move
   media to Supabase storage.

## Known gaps

- **Uploaded media is not replicated.** Anything under `public/uploads/*`
  written during the outage is on the Singapore EBS volume and is destroyed
  when we tear down. Mitigation: flip `STORAGE_PROVIDER=supabase` in `.env`
  (already a supported code path) so all media goes to Supabase Storage,
  which survives Mumbai outages independently.
- **Supabase dependency.** If Supabase itself is down, this DR plan doesn't
  help — we only fail over compute, not the DB. That's a separate round.
- **Cloudflare IP ranges drift.** The SG uses the `cloudflare_ip_ranges`
  Terraform data source so `terraform apply` picks up the current list at
  plan time, but once the box is running, if Cloudflare adds a new CIDR
  you need to `terraform apply` again to refresh the SG. Worth monitoring:
  Cloudflare announces IP changes via RSS.
- **10-minute RTO includes a Docker build.** `scripts/deploy.sh` does
  `docker compose build` on first run. If the build time balloons, the
  RTO balloons with it.

## Cost estimate

When destroyed (99%+ of the time):
- S3 `.env` versions: pennies/month
- KMS key: $1/mo
- **Total: ~$1/mo**

When provisioned (during an outage):
- t3.large in Singapore: ~$0.09/hr
- EIP (while attached): free
- **Total: ~$2/day while running**
