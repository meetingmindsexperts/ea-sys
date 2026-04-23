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

### 3. Set up the Mumbai→Singapore backup crons

On the Mumbai box (`sudo -iu ubuntu`, then `crontab -e`):

```cron
# Daily .env snapshot to Singapore DR bucket (21:00 UTC = 02:30 IST)
0 21 * * * aws s3 cp /home/ubuntu/ea-sys/.env s3://ea-sys-dr-singapore/env/$(date -u +\%F).env --region ap-southeast-1 >> /home/ubuntu/cron-dr-backup.log 2>&1

# Hourly uploads mirror to Singapore DR bucket (covers user-uploaded media)
0 * * * * aws s3 sync /home/ubuntu/ea-sys/public/uploads/ s3://ea-sys-dr-singapore/uploads/ --region ap-southeast-1 --exclude ".gitkeep" >> /home/ubuntu/cron-dr-uploads-sync.log 2>&1
```

Both require the Mumbai EC2's IAM role (`ea-sys-mumbai-ec2-role`) to have
`s3:PutObject` on `arn:aws:s3:::ea-sys-dr-singapore/*` and
`kms:GenerateDataKey`/`kms:Encrypt` on the Singapore KMS key — attach the
inline policy `DRBackupToSingapore` to the role.

RPO implications:
- `.env`: up to 24 hours of `.env` changes lost in a regional disaster. Acceptable (`.env` rarely changes). Run the command manually after adding a new secret if you need tighter.
- Uploads: up to 1 hour of user uploads lost in a regional disaster. Tighten the cron to `*/5 * * * *` (every 5 min) if that's too loose.

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

4. **Update DNS at the registrar.**
   - At your domain registrar (GoDaddy/etc.) → DNS → `events` A record → replace value with the new IP.
   - TTL is usually 1 hour; lower it to 60 seconds before a known-risky change for faster failover.
   - When a CDN (CloudFront/Cloudflare) is later added, this step updates the CDN origin instead of DNS directly, and tighten `http_allow_cidrs` in `terraform.tfvars` to the CDN's IP ranges.

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
2. **Before flipping DNS back**, sync any uploads that happened on the
   Singapore DR box back to the S3 bucket so Mumbai can restore them:
   ```bash
   # On the DR box (via SSM):
   aws s3 sync /home/ubuntu/ea-sys/public/uploads/ \
     s3://ea-sys-dr-singapore/uploads/ --region ap-southeast-1
   ```
   Then on Mumbai, pull them down:
   ```bash
   aws s3 sync s3://ea-sys-dr-singapore/uploads/ \
     /home/ubuntu/ea-sys/public/uploads/ --region ap-southeast-1
   ```
3. **Registrar DNS** → `events` A record → point back at the Mumbai EIP.
4. Verify: `curl -I https://events.meetingmindsgroup.com/api/health` returns
   200 with `database: connected`.
5. `cd infra/dr && terraform destroy -auto-approve` — kills the Singapore box.
   (Don't destroy before step 2, or fresh uploads written during the outage
   are gone.)

## Known gaps

- **Uploads written during the outage window itself are at risk.** The normal
  flow is Mumbai hourly sync → S3 bucket → DR box pulls on boot. During an
  outage, Mumbai's cron can't run. Uploads that happen *on the DR box* during
  the outage live on its ephemeral EBS volume until step 2 of the post-incident
  runbook above sends them back. If you skip that step or `terraform destroy`
  before syncing, those outage-window uploads are lost. Future fix: a reverse
  cron on the DR box that periodically pushes `public/uploads/` back to S3.
- **Supabase dependency.** If Supabase itself is down, this DR plan doesn't
  help — we only fail over compute, not the DB. That's a separate round.
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
