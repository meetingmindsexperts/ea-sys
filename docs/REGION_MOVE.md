# Moving EA-SYS between regions: the box, the bucket, or both

Written 2026-09-07, the day uploads moved from the server disk to S3
(MAINTENANCE_LOG.md MAINT-002). Before that day, "move the box" meant "move the
box and the 70 MB of files on its disk". Now the files live in a bucket that is
pinned to a *region*, not to a machine, and that changes the procedure in both
directions: replacing the box got easier, and moving the box to another region
gained a precondition that did not exist before.

This is the runbook for three situations. Read section 0 first; it is the map
of what is pinned where, and every step below follows from it.

## 0. What is pinned where

| Piece | Scope | What a move needs |
|---|---|---|
| IAM roles and policies | **Global** | Nothing. `ea-sys-mumbai-ec2-role` and `ea-sys-dr-singapore-role` work in any region |
| KMS keys (`alias/ea-sys-uploads`, the DR key) | **Regional** | A key can only encrypt objects in its own region. Objects copied to a bucket in another region are re-encrypted under that bucket's default key automatically |
| Uploads bucket `ea-sys-uploads` | **Regional** (ap-south-1) | Readable and writable from any region with the right IAM (cross-region latency ~60 ms per object from Singapore, ~33 ms from Dubai). Moving it is a bucket-to-bucket `aws s3 sync` |
| DR bucket `ea-sys-dr-singapore` | **Regional** (ap-southeast-1) | Stays put unless the move is *to* Singapore, in which case pick another DR region |
| EC2 instance, EBS volume, snapshots, Elastic IP, security group | **Regional** | Rebuilt in the target region from the runbook, not migrated |
| ECR repository `ea-sys` | **Regional** (ap-south-1) | `scripts/deploy.sh` hardcodes the registry; cross-region pulls work while ap-south-1 is up, otherwise the deploy falls back to an on-box build |
| SES sending identity + DKIM | **Regional** (ap-south-1, `AWS_SES_REGION`) | Cross-region API calls work while ap-south-1 is up. A move that must survive an ap-south-1 outage needs the domain verified in the target region, which is a DNS change to do in advance |
| CloudWatch log groups, the 6 alarms, the SNS topic | **Regional** | The agent ships to the instance's own region; alarms exist only for the Mumbai instance and are recreated by hand |
| Supabase database | **Mumbai, and cannot move to the Middle East** (no Supabase region there) | Every scenario below keeps the database where it is |
| DNS A record, TLS certificate, nginx, fail2ban, crontab, `.env`, MediaMTX | **On the box** | Recreated per box; `.env` restores from the DR bucket's nightly snapshot |
| Stripe, Zoom, Sentry, the EU contact mirror | External, URL-based | Unaffected by any region change |

## 1. The rule that decides whether to move at all

The application talks to the database many times per page and to the bucket
once per file. **Application-to-database latency multiplies; user-to-application
latency does not.** The database is in Mumbai and stays there, so a permanent
move of the box away from Mumbai makes every query 15 to 30 times slower for a
residency claim that the database cannot honour anyway. This is why the August
plan rejected Dubai and Bahrain for the box (UAE_DOCUMENT_RESIDENCY_PLAN.md).

So: **the box follows the database, and the bucket follows the box.** The two
legitimate reasons to break that rule are a regional outage (temporary, the
slowness is accepted) and a residency requirement for the *files* alone, which
scenario C covers without moving the box.

## 2. Scenario A: replace the box in the same region

This is FROM_SCRATCH_REBUILD.md, and S3 made it shorter. The two lines that
changed there:

- Phase 1.1: the instance role carries a sixth inline policy, `UploadsS3Storage`
  (object read/write/delete on `ea-sys-uploads`, list on the bucket, the four
  KMS actions on `alias/ea-sys-uploads`).
- Phase 3: there is **no uploads restore**. The restored `.env` carries
  `STORAGE_PROVIDER=s3`, `S3_UPLOADS_BUCKET`, `S3_UPLOADS_REGION`, and the new
  box serves every file on first boot. `mkdir -p public/uploads` stays because
  compose mounts it, but it can be empty.

Verification is section 6.

## 3. Scenario B: the box moves to another region, the bucket stays

The failover case (infra/dr/README.md "Promotion runbook") and any temporary
relocation. **Precondition, or every photo is AccessDenied:** the target box's
role must be allowed to use the Mumbai bucket and its key. For the Singapore
standby that is the `uploads` statements in `infra/dr/main.tf`
(`data.aws_iam_policy_document.dr_s3_read`), applied with `terraform apply`.
No key-policy edit is needed: the uploads key's policy delegates to IAM through
its account-root statement.

Then two modes, chosen by whether Mumbai's S3 is reachable:

**B1, Mumbai S3 is up (the usual case, including most "the Mumbai box died"
events).** Boot the box with the restored `.env` as is. It reads and writes the
Mumbai bucket cross-region. Nothing to copy, and files uploaded during the
failover land in the same bucket, so returning to Mumbai needs no uploads step
at all. Cost: one cross-region round trip per file served, ~60 ms from
Singapore. Acceptable for an outage; not a permanent posture.

**B2, the whole of ap-south-1 is unreachable.** The bucket is unreachable too.
On the target box, restore the mirror to disk and run on the local provider:

```bash
sudo aws s3 sync s3://ea-sys-dr-singapore/uploads/ /home/ubuntu/ea-sys/public/uploads/ --region ap-southeast-1 --exclude "*/.gitkeep"
sudo sed -i 's/^STORAGE_PROVIDER=s3/STORAGE_PROVIDER=local/' /home/ubuntu/ea-sys/.env
bash scripts/deploy.sh
```

Uploads made in this mode exist only on that box's disk. **Before returning to
Mumbai**, push them into the primary bucket, then flip the provider back:

```bash
aws s3 sync /home/ubuntu/ea-sys/public/uploads/ s3://ea-sys-uploads/ --region ap-south-1 --exclude "*/.gitkeep"
```

Other regional pieces during B: SES keeps working through the Mumbai identity
in B1 and stops in B2 unless the domain was pre-verified in the target region;
ECR pulls fail in B2 and `deploy.sh` builds on the box instead (slow, see
INC-001, plan a swap file); CloudWatch logs appear in the target region; there
are no alarms on the new box until you create them; the crontab's `.env`
snapshot and pg-dump lines keep working because the DR bucket is not in Mumbai.
The mirror line (bucket → Singapore) is a no-op in B2 and must not be replaced
with the old disk-sourced one.

## 4. Scenario C: the bucket moves to another region, the box stays

The residency case (UAE when `me-central-1` recovers). Nothing on the box
changes except three env values. Cross-region reads cost ~33 ms per object from
Mumbai to Dubai, which is the price of the residency claim; do not combine with
a database that stays in Mumbai unless that price is accepted.

1. **Target region:** KMS key (symmetric, single-Region, the instance role in
   its key policy's "Allow use of the key"), bucket with all four public-access
   blocks, versioning, SSE-KMS default under that key, Bucket Key on, Object
   Lock off. Same recipe as UAE_DOCUMENT_RESIDENCY_PLAN.md section 5, steps 1-2.
2. **IAM:** extend `UploadsS3Storage` (and the DR role's statements) with the
   new bucket ARN and the new key ARN. Keep the old ones until the bake ends.
3. **Copy, server-side, re-encrypting under the destination's default key:**
   ```bash
   aws s3 sync s3://ea-sys-uploads/ s3://<new-bucket>/ --source-region ap-south-1 --region <target>
   ```
4. **Verify independently of the copy tool** (the method from MAINT-002):
   ```bash
   aws s3api list-objects-v2 --bucket ea-sys-uploads --region ap-south-1 --query 'Contents[].[Key,Size]' --output text | grep -v '\.gitkeep' | tr '\t' ' ' | LC_ALL=C sort | sha256sum
   aws s3api list-objects-v2 --bucket <new-bucket>  --region <target>   --query 'Contents[].[Key,Size]' --output text | grep -v '\.gitkeep' | tr '\t' ' ' | LC_ALL=C sort | sha256sum
   ```
   Identical hashes or do not proceed.
5. **Switch:** `S3_UPLOADS_BUCKET` and `S3_UPLOADS_REGION` in `.env`,
   `bash scripts/deploy.sh`. Re-run the sync once more to sweep anything written
   between step 3 and the deploy.
6. **Mirror:** change the source in the hourly crontab line to the new bucket.
7. **Bake, then retire:** keep the old bucket a week. Rollback is the two env
   values plus a redeploy. Retiring a versioned bucket means deleting object
   versions first; do it from the console with the bucket emptied deliberately.

## 5. Scenario D: both move

Prepare the target region first (key, bucket, IAM, an ECR repository if the
move is permanent, SES identity and DKIM, alarms), then copy the files
(scenario C steps 1-4), then build the box there pointing at the new bucket
(scenario A on new soil), flip DNS, move the mirror line, and only then
decommission Mumbai after a bake. For a permanent move, also update
`AWS_REGION`/`ECR_REGISTRY` in `scripts/deploy.sh`, `aws-region` in
`.github/workflows/deploy.yml`, and `AWS_SES_REGION` in `.env`; the GitHub OIDC
role is global and needs no change. And re-read section 1: a permanent move of
the box away from the database is the one thing this document advises against.

## 6. Verification, whichever scenario

From outside the box, so it proves what a user sees:

```bash
curl -s -o /dev/null -w "status=%{http_code} bytes=%{size_download}\n" https://events.meetingmindsgroup.com/uploads/photos/<a real key>.jpg   # bytes must equal the S3 object
curl -s -o /dev/null -w "%{http_code}\n" https://events.meetingmindsgroup.com/uploads/reimbursements/x.pdf                                  # 403, private prefix
curl -s -o /dev/null -w "%{http_code}\n" https://events.meetingmindsgroup.com/uploads/photos/2026/01/missing.jpg                            # 404, not 500
curl -s -o /dev/null -w "%{http_code}\n" https://events.meetingmindsgroup.com/health; curl -s -o /dev/null -w "%{http_code}\n" https://events.meetingmindsgroup.com/worker/health
```

On the box: both containers show the three storage variables in `docker exec
<container> env`, `app.log` has `storage:s3-client-initialised` from the `web`
tier after the first request, and the error log has no `storage:` lines. At the
next full hour the mirror heartbeat `heartbeats/uploads-mirror` in the DR
bucket has a new timestamp.

## 7. What never moves

Supabase (Mumbai), Stripe, Zoom, Sentry, the EU contact mirror, and the
Singapore DR bucket unless Singapore is the destination.
