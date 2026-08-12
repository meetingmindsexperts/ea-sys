# Ransomware / extortion response

> **In it right now?** Jump to [§4 The runbook](#4-the-runbook). Read [§0](#0-the-sixty-second-version)
> first, it is four lines.
>
> Companions: [DDOS_RESPONSE_PLAN.md](DDOS_RESPONSE_PLAN.md) (availability attack),
> [MCP_SECURITY.md](MCP_SECURITY.md) (external-agent access), [ROLLBACK.md](ROLLBACK.md)
> (pinned-image redeploy), [FROM_SCRATCH_REBUILD.md](FROM_SCRATCH_REBUILD.md) (rebuild a box),
> [infra/dr/README.md](../infra/dr/README.md) (restore mechanics), [INCIDENTS.md](INCIDENTS.md)
> (where the write-up goes afterwards).
>
> **Verified against the live account on 2026-08-12.** Re-verify §2 with the commands in §7
> before trusting the numbers.

---

## 0. The sixty-second version

1. **Do not pay yet, and do not reboot or `docker restart` anything.** A reboot destroys the
   evidence and can trigger a dead-man switch. Containment does not require a reboot.
2. **The database is not on the box.** It is Supabase. "They encrypted our server" does not
   encrypt the database.
3. **The box cannot delete the backups.** Its IAM role has `PutObject`/`GetObject`/`ListBucket` on
   the DR bucket and **no delete of any kind**, and versioning is on. An attacker with total control
   of the box can overwrite backups but cannot destroy the previous versions. See §2 for the one
   way that protection expires.
4. **Assume the data is already copied.** Modern extortion exfiltrates first and encrypts second.
   Plan for a disclosure obligation regardless of whether you recover the files.

---

## 1. What this actually looks like against EA-SYS

Four different attacks all arrive as "pay us". They need different responses, and the first job in
an incident is telling them apart.

| # | Scenario | What is actually at risk | Recovery |
|---|---|---|---|
| **A** | **Box compromised.** EC2 rooted, host files encrypted, containers killed. | `public/uploads/` on the host volume, `.env` on disk, SES send ability, whatever the instance role reaches. **Not the database.** | Rebuild the box from [FROM_SCRATCH_REBUILD.md](FROM_SCRATCH_REBUILD.md), restore uploads from S3. Hours. |
| **B** | **Supabase compromised.** Stolen `DATABASE_URL` used to drop, encrypt or exfiltrate the DB. | Everything. Attendees, payments, abstracts, CRM. | Restore the newest hourly `pg_dump`. Up to 1h of writes lost. |
| **C** | **AWS account compromised.** Root or an admin key. Buckets purged, instances terminated, KMS key scheduled for deletion. | Everything, including the backups. **This is the one the current controls do not survive.** See §6. | Depends entirely on AWS support and whether versions were purged. |
| **D** | **Pure data extortion.** No encryption at all. "We have your attendee list, pay or we publish." | Reputation, PDPL exposure, sponsor and faculty trust. | There is nothing to restore. This is a legal and comms incident, not a technical one. |

**D is the most likely and the least prepared for.** It is also the one where the absence of
CloudTrail hurts most, because the first question everyone asks is "what did they take", and right
now we cannot answer it.

---

## 2. The facts that decide your options

Verified read-only on 2026-08-12. Commands to re-check are in §7.

| Control | State | Why it matters |
|---|---|---|
| **Database location** | Supabase, **not on the box** | Scenario A cannot encrypt the DB. This is the single biggest structural advantage we have. |
| **DR bucket versioning** | **Enabled** (`ea-sys-dr-singapore`, ap-southeast-1) | An overwrite creates a new version. The old one survives. |
| **Instance role delete rights on DR bucket** | **None.** `PutObject` / `GetObject` / `ListBucket` only | A fully owned box **cannot** delete backups or versions. Verified in the `DRBackupToSingapore` inline policy. |
| **`db/` noncurrent version expiry** | **7 days** | **The gap.** An attacker does not need delete rights: overwrite every dump with garbage, wait 8 days, and AWS's own lifecycle rule deletes the good versions. `uploads/` and `env/` have no such rule, so only the most critical prefix carries it. |
| **`db/` current expiry** | 30 days (real depth measured: oldest object 2026-07-12) | Anything older than ~31 days is unrecoverable. Attacker dwell time is routinely longer than that. |
| **S3 Object Lock** | **Not configured** | Nothing is immutable. Versions are deletable by any principal with `s3:DeleteObjectVersion`. |
| **MFA Delete** | **Not enabled** | An admin credential alone can purge version history. |
| **IMDSv2** | **Required**, hop limit 2 | A plain SSRF cannot steal the instance role. Hop limit 2 is needed for containers to reach IMDS, so a compromised **container** still can. |
| **ECR access from the box** | **Pull only**, no push | A compromised box cannot poison the image registry. Rollback images stay trustworthy. |
| **KMS rights from the box** | Encrypt / Decrypt / GenerateDataKey. **No** `ScheduleKeyDeletion` or `DisableKey` | The box cannot brick the key that protects the backups. |
| **CloudTrail** | **None configured** | **No forensics.** We cannot reconstruct who called what, when, or from where. Console Event History gives ~90 days of management events, not exportable at scale, no S3 object-level events. |
| **GuardDuty** | **None, in any region** | **No detection.** We find out from the ransom note. Dwell time is unbounded. |
| **Supabase PITR** | Not purchased | No second-precision rollback. The hourly dump is the only DB recovery point. |
| **Singapore DR box** | **Does not exist** | DR is bucket-only and cold. There is no warm standby to fail over to. |
| **Sessions** | Stateless JWT, 24h | **The only way to sign everyone out is rotating `NEXTAUTH_SECRET`.** See §4 Phase 6, it has a sharp edge. |

**The sentence that summarises all of it:** we survive losing the box, we survive losing the
database, and we do not currently survive losing the AWS account.

---

## 3. Before you touch anything

Three decisions, made now, not at 3am.

- **Who declares an incident?** One named person. In practice: Krishna, with Medhat informed
  immediately for anything involving attendee data.
- **Do we have cyber insurance?** If yes, most policies **require** notifying the insurer before
  engaging responders or paying anything, or the claim is void. Find this out before you need it.
- **Out-of-band comms.** If the box or a laptop is compromised, do not coordinate the response over
  a channel the attacker may be reading. Agree a fallback (phone, a separate WhatsApp group) in
  advance.

---

## 4. The runbook

### Phase 0. Stop. Ninety seconds of discipline.

- **Do not reboot. Do not `docker restart`. Do not run the attacker's "decryptor".**
- **Do not delete the ransom note.** It identifies the group, which tells you their usual behaviour
  and whether a free decryptor exists.
- **Start a timeline document immediately.** Every action with a UTC timestamp. This is what the
  post-mortem, the insurer and any regulator will ask for, and nobody remembers it afterwards.
- Screenshot the ransom note and anything on screen.

### Phase 1. Contain, without destroying evidence

The goal is to stop ongoing exfiltration while keeping the machine intact.

```bash
# Isolate at the network edge, NOT by stopping the instance.
# Create an empty security group and swap the instance onto it: the machine
# stays running (memory, processes, open handles all preserved) but can talk
# to nobody. SSM will also be cut, which is the point.
aws ec2 create-security-group --group-name ea-sys-quarantine \
  --description "Incident isolation" --vpc-id <VPC_ID> --region ap-south-1

aws ec2 modify-instance-attribute --instance-id i-0b51ab1213d084640 \
  --groups <QUARANTINE_SG_ID> --region ap-south-1
```

**Judgement call:** if data is actively being exfiltrated, containment beats forensics. Isolate
first, always. If the situation looks static (files already encrypted, note left, nothing running),
take the snapshot in Phase 3 **before** isolating so you keep SSM access.

**In parallel, protect the credentials that reach beyond the box:**

- Disable the Stripe API key in the Stripe dashboard (money movement first).
- Revoke every EA-SYS API key and OAuth grant (see [MCP_SECURITY.md §5](MCP_SECURITY.md)).
- Rotate the Supabase database password. **This is the one that stops Scenario B**, and the
  credential is in `.env`, which is on the box, so assume it is taken.

### Phase 2. Classify

Answer, in this order:

1. **Is the database still intact?** Connect from your laptop, not the box:
   `npm run prod:psql -- -c 'SELECT count(*) FROM "Registration";'`
   Intact means Scenario A, and the blast radius just shrank enormously.
2. **Are the backups intact?** `aws s3 ls s3://ea-sys-dr-singapore/db/ --recursive | tail -5`.
   If the newest objects are garbage, list versions (§7) and find the last good one.
3. **Is this AWS-account level?** Check for unexpected IAM users, access keys, or terminated
   resources. If yes, escalate: this is Scenario C, contact AWS Support immediately, and the
   priority becomes preventing version purge.
4. **Is anything encrypted at all?** If not, it is Scenario D and the whole response is legal and
   communications, not restore.

### Phase 3. Preserve the evidence

Do this before rebuilding. It is two commands and you cannot get it back later.

```bash
# Snapshot the root volume. This is the forensic image.
aws ec2 describe-instances --instance-ids i-0b51ab1213d084640 --region ap-south-1 \
  --query 'Reservations[].Instances[].BlockDeviceMappings[].Ebs.VolumeId' --output text

aws ec2 create-snapshot --volume-id <VOL_ID> --region ap-south-1 \
  --description "FORENSIC ea-sys $(date -u +%FT%TZ) DO NOT DELETE" \
  --tag-specifications 'ResourceType=snapshot,Tags=[{Key=incident,Value=ransomware},{Key=retain,Value=forever}]'
```

Also preserve: CloudWatch log groups `ea-sys/app` and `ea-sys/error` (export the relevant window to
S3 before retention rolls them off at 30 and 90 days), the ransom note, and the `SystemLog` table
rows around the incident window.

### Phase 4. Rebuild clean

**Never disinfect and reuse.** You cannot prove a compromised host is clean, and re-using it is how
organisations get hit a second time by the same foothold.

1. Launch a **new** EC2 from a fresh Ubuntu AMI. Do not restore from a snapshot of the compromised
   volume.
2. Follow [FROM_SCRATCH_REBUILD.md](FROM_SCRATCH_REBUILD.md) end to end: IAM role, security group,
   **swap** (the INC-001 trap), packages, nginx from `deploy/nginx.live-snapshot.conf`, fail2ban,
   CloudWatch agent, crontab.
3. Pull a **known-good image tag** from ECR, chosen as one pushed before the earliest evidence of
   compromise. ECR is pull-only from the box, so the registry itself is trustworthy.
   `IMAGE_TAG=<40-char-sha> bash scripts/deploy.sh` per [ROLLBACK.md](ROLLBACK.md).
4. Do not reuse the old Elastic IP until you are satisfied the attacker has no persistence keyed to
   it.

### Phase 5. Restore data

**Uploads** (`public/uploads/`, the photos, banners, certificates):

```bash
aws s3 sync s3://ea-sys-dr-singapore/uploads/ /home/ubuntu/ea-sys/public/uploads/ --region ap-southeast-1
sudo chown -R 1001:1001 /home/ubuntu/ea-sys/public/uploads   # the container's write uid, see INC-004
```

If the uploads mirror itself was overwritten, restore **by version**: `uploads/` has no noncurrent
expiry, so every prior version is still there (§7 has the command).

**Database**, only if Scenario B:

- Newest good dump: `aws s3 ls s3://ea-sys-dr-singapore/db/ --recursive | sort | tail -5`
- **Restore into a scratch database first and verify it**, using
  [`scripts/dr-restore-drill.sh`](../scripts/dr-restore-drill.sh), which already does the
  `DROP SCHEMA public CASCADE` dance and row-counts nine critical tables. Never restore straight
  over production.
- Remember `pg_dump --schema=public`: the dump is portable to any vanilla Postgres 17 (RDS, a fresh
  Supabase project, the scratch container). You are not locked to the compromised project.

**Choosing the restore point:** pick the newest dump that predates the earliest evidence of
compromise. Without CloudTrail this is a judgement call from app logs, which is exactly why §6
ranks CloudTrail first.

### Phase 6. Rotate everything, in this order

1. **Supabase DB password** (done in Phase 1 if you were quick).
2. **Stripe** secret key and webhook signing secret. Per-org keys too if any tenant configured
   their own.
3. **AWS**: any long-lived access keys. The instance role needs no rotation, it is temporary
   credentials, but a new instance means a new role session anyway.
4. **Zoom**, **AssemblyAI**, **Anthropic / OpenAI**, **Brevo / SendGrid** if present.
5. **GitHub**: the deploy SSH key and any Actions secrets. A GitHub compromise is a path to the box.
6. **`NEXTAUTH_SECRET`** last, and read this paragraph before you do it.

> **`NEXTAUTH_SECRET` has two consequences people forget.**
>
> **It is the only way to sign everyone out.** Sessions are stateless JWTs, so there is no session
> table to clear. Rotating it invalidates every outstanding token immediately, which in a breach is
> exactly what you want. See [SESSION_ARCHITECTURE.md](SESSION_ARCHITECTURE.md).
>
> **It also decrypts the per-org integration credentials.** Zoom, EventsAir, Stripe and AI keys are
> stored AES-256-GCM encrypted in `Organization.settings`, keyed on this secret. Rotating it makes
> every one of them **permanently unreadable**, and they must be re-entered by hand in Settings →
> Integrations for every organization. Budget for that, and warn the organizers before you do it,
> not after.

### Phase 7. Legal and notification

Not optional, and not your call alone.

- **PDPL (UAE Federal Decree-Law 45/2021).** A personal-data breach must be notified to the UAE
  Data Office, and to affected individuals where there is risk to their privacy. EA-SYS holds
  attendee names, emails, phone numbers, employer, and in the medical-conference context data that
  reads as health-adjacent. Treat the threshold as met unless counsel says otherwise.
- **Payment data.** Card numbers never touch EA-SYS (Stripe-hosted checkout), which materially
  reduces obligations. Say so accurately in any disclosure: we hold payment *records*, not card
  data.
- **Notify**, in this order: Medhat, insurer (before engaging anyone or paying anything), legal
  counsel, then Stripe and Supabase as processors.
- **Do not** publish a technical account of the vulnerability until it is fixed everywhere.

### Phase 8. After

- Write it up in [INCIDENTS.md](INCIDENTS.md) as **INC-005** with the same shape as INC-001 through
  INC-004: what happened, the diagnosis trail including the wrong turns, root cause, the durable
  fix, and the rule that prevents the class.
- Close the §6 gaps that the incident proved real.
- Re-run the [ROLLBACK.md §1.6](ROLLBACK.md) drill and a DR restore drill afterwards, because the
  procedures will have drifted.

---

## 5. Should we pay?

A business and legal decision, not a technical one, but the technical inputs are these.

**Arguments against, specific to us:** we hold recoverable backups the attacker's own access could
not delete (§2), so for Scenarios A and B **paying buys nothing we cannot do ourselves**. Payment
also funds the next attack and marks us as a payer, which correlates with being hit again.

**The honest caveats.** Roughly a third of organisations that pay never receive usable decryption.
In double-extortion, paying buys a *promise* of deletion from a criminal, which is unverifiable and
frequently broken. And a PDPL notification obligation is triggered by the breach, not by whether
you paid, so payment does not make the legal problem go away.

**The one case worth genuine deliberation** is Scenario D combined with a real, verified data
sample, where the harm is disclosure of faculty and attendee data and there is nothing to restore.
Even then: insurer and counsel first, always, and check sanctions exposure before any transfer.

**Never negotiate directly.** If it gets that far, use a professional responder, engaged through
the insurer.

---

## 6. The gaps, ranked, with what they cost

Everything below is verified missing as of 2026-08-12.

| # | Gap | Consequence in an incident | Rough cost |
|---|---|---|---|
| 1 | **No CloudTrail** | You cannot answer "when did they get in" or "what did they take". That is the first question from the insurer, counsel and the regulator, and it also picks your restore point. | ~$2/month. One command. |
| 2 | **`db/` noncurrent versions expire in 7 days** | An attacker needs no delete rights: overwrite the dumps, wait 8 days, and AWS deletes the good versions for them. Raise to 90 days or drop the rule. | Free. Pennies of storage. |
| 3 | **A backup the production credentials cannot write to** | Every backup today is written by the box, with the box's role. Versioning is the only thing between an owned box and useless backups. A pull-based copy (separate account or a Lambda the box cannot invoke) removes that dependency entirely. This is the strongest single control available. | ~$1 to $5/month. |
| 4 | **No GuardDuty** | No detection at all. Dwell time is bounded only by when the attacker chooses to tell you. | ~$10 to $30/month. |
| 5 | **`.env` stored plaintext in the DR bucket, daily** | The box's role has `GetObject` on the whole bucket, so a compromised box reads **every historical secret set**, including ones you rotated months ago. Move to Secrets Manager, or at minimum a separately-keyed prefix the app role cannot read. | Low. |
| 6 | **No Object Lock, no MFA Delete** | Scenario C (account compromise) destroys everything. Object Lock in governance mode makes versions undeletable for a retention window. | Free, but needs care: compliance mode cannot be undone. |
| 7 | **DB backup horizon is 31 days** | Dwell time frequently exceeds a month. A discovery on day 40 has no clean restore point. | Storage only. |
| 8 | **No Supabase PITR** | Hourly dumps are the only DB recovery point. Acceptable today, revisit if RPO tightens. | $25 to $50/month. |

**If you do only two things: CloudTrail (#1) and the 7-day expiry (#2).** Together they are under
five dollars a month and they are the difference between "we restored and we know what happened"
and "we restored and we are guessing".

---

## 7. Verification commands

Re-run these quarterly. They are all read-only.

```bash
# Backups: are versions protected, and how far back do they really go?
aws s3api get-bucket-versioning --bucket ea-sys-dr-singapore --region ap-southeast-1
aws s3api get-bucket-lifecycle-configuration --bucket ea-sys-dr-singapore --region ap-southeast-1
for p in db env uploads; do
  echo -n "$p oldest: "; aws s3 ls s3://ea-sys-dr-singapore/$p/ --recursive --region ap-southeast-1 | sort | head -1
done

# Can the box delete backups? (want: no DeleteObject on the DR bucket)
aws iam get-role-policy --role-name ea-sys-mumbai-ec2-role --policy-name DRBackupToSingapore

# Metadata service hardened? (want: HttpTokens = required)
aws ec2 describe-instances --instance-ids i-0b51ab1213d084640 --region ap-south-1 \
  --query 'Reservations[].Instances[].MetadataOptions'

# Forensics + detection (want: at least one trail, at least one detector)
aws cloudtrail describe-trails --query 'trailList[].Name'
aws guardduty list-detectors --region ap-south-1

# During an incident: find the last GOOD version of an overwritten backup
aws s3api list-object-versions --bucket ea-sys-dr-singapore \
  --prefix db/ --region ap-southeast-1 \
  --query 'Versions[].{Key:Key,Id:VersionId,When:LastModified,Size:Size}' --output table

# ...and pull that specific version
aws s3api get-object --bucket ea-sys-dr-singapore --key <KEY> \
  --version-id <VERSION_ID> --region ap-southeast-1 restored.dump
```

---

*Written 2026-08-12 from a read-only audit of the live account. Re-verify §2 quarterly and after any
change to the DR bucket lifecycle, the instance role, or the backup cron.*
