# Encrypting the EC2 root volume

**Status:** ✅ **PERFORMED 2026-08-21**, successfully, in **7 min 45 s** — see
[MAINTENANCE_LOG.md](MAINTENANCE_LOG.md) MAINT-001 for the as-executed record,
the verification results and what the estimates got wrong. Written 2026-08-19,
shortened 2026-08-20 after measuring the fast path (§3).

**Keep this document.** It is the procedure for the *next* volume (the Singapore
DR box is still unencrypted), and §6 is the rollback that stays open until the
old volume is deleted.
**Why:** the root volume is `Encrypted: false`, which is the weakest answer on
the client security questionnaire (`SECURITY_AND_PRIVACY_POSTURE.md` §0.2).
**Downtime:** 7 to 10 minutes, planned. (The original single-pass version of this
document said 20 to 40; see §3 for what changed.)

---

## 0. The one property that makes this safe

**Nothing in this procedure modifies the original volume.** A snapshot is a
read. The encrypted volume is a new object. The original is detached, not
erased, and it stays in the account until you explicitly delete it.

So at every step before the final cleanup, **rollback is reattaching the volume
you already have**, and it takes about five minutes. That is the failover
strategy, and it is stronger than any backup because the original disk itself is
sitting there intact.

---

## 1. Verified live state (2026-08-20)

| Item | Value |
|---|---|
| Instance | `i-0b51ab1213d084640`, `t3.large`, `ap-south-1b` |
| Root volume | `vol-073ca563deaa8732a` |
| Size / type | 50 GB, **gp3**, **3000 IOPS**, **125 MB/s** |
| Root device name | `/dev/sda1` |
| Encrypted | **false** |
| DeleteOnTermination | **true** (see §7) |
| Elastic IP | `3.108.247.193`, **attached**. Survives stop/start, so DNS does not change |
| Default EBS encryption | **enabled** in `ap-south-1` and `ap-southeast-1` (2026-08-20), key `alias/aws/ebs` |

**Recreate the gp3 settings explicitly.** A volume created from a snapshot
without them gets defaults. Those defaults happen to be 3000/125 today, so it
would be correct by luck, and correctness by luck is worth one extra flag.

---

## 2. Which KMS key: use `alias/aws/ebs`

Use the **AWS-managed** EBS key, not a customer-managed one. This is the
opposite of the recommendation for the document bucket, and deliberately.

- **A root volume encrypted with a customer-managed key becomes unbootable if
  that key is ever disabled, deleted or has its policy broken.** The blast
  radius of a key mistake is the whole server, not one prefix.
- The AWS-managed key is free; a customer-managed key is about $1/month.
- Both satisfy "encrypted at rest with AES-256" on a questionnaire.

Customer-managed keys buy key-policy control, rotation and revocation. Those are
worth having for *documents*, where revoking access to a prefix is a meaningful
action. They are not worth having for the disk your operating system boots from.

Since default encryption is enabled account-wide in these regions, the new volume
picks this key up automatically. Nothing needs to be passed.

---

## 3. Why there is no `copy-snapshot` step

The obvious shape of this job is: snapshot, **copy the snapshot with encryption
on**, create a volume from the encrypted copy. That copy is a full 50 GB
re-encrypt and is what made the original estimate 20 to 40 minutes.

**It is unnecessary once encryption-by-default is enabled.** `CreateVolume` from
an *unencrypted* snapshot then produces an *encrypted* volume, with the
re-encryption happening implicitly as blocks are pulled.

**Measured, not assumed (2026-08-20):** a throwaway volume created from the
unencrypted April snapshot `snap-08e84992f929dc0b4` came back
`Encrypted: true`, key `alias/aws/ebs`. The test volume was deleted immediately.
**If you ever run this in a region where default encryption is off, the copy step
comes back.** Check §1 before trusting the short path.

**The general point worth keeping:** an account-level default changed what the
per-resource API does. Re-measure a plan after changing a default, because the
cheapest step is often the one that stopped being necessary.

---

## 4. Pre-flight (do not skip)

```bash
# 1. No live event in the window. Check the events calendar. A conference
#    morning is the wrong time: check-in, badges and the kiosk all go down.

# 2. DR is current.
aws s3 ls s3://ea-sys-dr-singapore/db/ --recursive --region ap-southeast-1 | tail -2
#    Expect a dump from within the last hour.

# 3. Default encryption is still on (this is what removes the copy step).
aws ec2 get-ebs-encryption-by-default --region ap-south-1

# 4. Record the current state so you can compare afterwards.
aws ec2 describe-volumes --region ap-south-1 --volume-ids vol-073ca563deaa8732a \
  --query 'Volumes[0].{Size:Size,Type:VolumeType,Iops:Iops,Throughput:Throughput,AZ:AvailabilityZone}'

# 5. Confirm the Elastic IP is still attached (it is what keeps DNS working).
aws ec2 describe-addresses --region ap-south-1 \
  --query 'Addresses[?InstanceId==`i-0b51ab1213d084640`].PublicIp' --output text
```

**Announce the window.** Public registration, the dashboard, check-in, the
kiosk, webinar join pages, the MCP endpoint and all background jobs are down for
the duration. Stripe retries failed webhooks for three days and the
invoice-reconciliation worker catches stragglers, so payments landing mid-window
settle late rather than being lost.

---

## 5. The procedure

### Step 0: Warm-up snapshot, ~20 minutes before, instance RUNNING

```bash
aws ec2 create-snapshot --region ap-south-1 \
  --volume-id vol-073ca563deaa8732a \
  --description "ea-sys warmup pre-encryption" \
  --tag-specifications 'ResourceType=snapshot,Tags=[{Key=Name,Value=ea-sys-warmup}]' \
  --query 'SnapshotId' --output text
```

**Zero downtime.** This does not pause I/O and does not touch the instance.

Its only job is to make the in-window snapshot incremental against something
recent, so that snapshot ships minutes of changed blocks instead of months.

**This snapshot is crash-consistent, not filesystem-consistent, and that is
fine because nothing ever boots from it.** The rule underneath: it is always
safe to snapshot a running volume as long as you never restore from that
snapshot. The consistency requirement attaches to restoring, not to copying.

Wait for `State: completed` before opening the window.

### Step 1: Stop the instance (window opens)

```bash
aws ec2 stop-instances --region ap-south-1 --instance-ids i-0b51ab1213d084640
aws ec2 wait instance-stopped --region ap-south-1 --instance-ids i-0b51ab1213d084640
```

Stopping gives the filesystem-consistent snapshot that step 2 needs. The
database is Supabase and lives off the box, so nothing transactional is at risk.

### Step 2: Snapshot the stopped volume

```bash
SNAP=$(aws ec2 create-snapshot --region ap-south-1 \
  --volume-id vol-073ca563deaa8732a \
  --description "pre-encryption root snapshot $(date -u +%FT%TZ)" \
  --query 'SnapshotId' --output text)
echo "SNAP=$SNAP"
aws ec2 wait snapshot-completed --region ap-south-1 --snapshot-ids "$SNAP"
```

**This is the one the new disk is built from.** It is also your second rollback
path, so keep it until the bake period ends.

Incremental against the warm-up, so expect well under a minute.

### Step 3: Create the encrypted volume, same AZ, same settings

```bash
NEW_VOL_ID=$(aws ec2 create-volume --region ap-south-1 \
  --snapshot-id "$SNAP" \
  --availability-zone ap-south-1b \
  --volume-type gp3 --iops 3000 --throughput 125 --size 50 \
  --tag-specifications 'ResourceType=volume,Tags=[{Key=Name,Value=ea-sys-root-encrypted}]' \
  --query 'VolumeId' --output text)
echo "NEW_VOL_ID=$NEW_VOL_ID"
aws ec2 wait volume-available --region ap-south-1 --volume-ids "$NEW_VOL_ID"

aws ec2 describe-volumes --region ap-south-1 --volume-ids "$NEW_VOL_ID" \
  --query 'Volumes[0].{Encrypted:Encrypted,Kms:KmsKeyId,Size:Size,Iops:Iops,Throughput:Throughput}'
```

**Check `Encrypted` is `true` before continuing.** If it is `false`,
default encryption is off and you should abort and restart the instance rather
than swap in an unencrypted disk for nothing.

**The AZ must be `ap-south-1b`.** A volume in another AZ cannot attach, and the
error arrives only at attach time.

**Keep the size at 50.** A larger disk boots fine but leaves the filesystem
undersized against it, which is a second job you did not plan for.

### Step 4: Swap

```bash
aws ec2 detach-volume --region ap-south-1 --volume-id vol-073ca563deaa8732a
aws ec2 wait volume-available --region ap-south-1 --volume-ids vol-073ca563deaa8732a

aws ec2 attach-volume --region ap-south-1 \
  --volume-id "$NEW_VOL_ID" --instance-id i-0b51ab1213d084640 --device /dev/sda1
aws ec2 wait volume-in-use --region ap-south-1 --volume-ids "$NEW_VOL_ID"
```

**`/dev/sda1` exactly.** That is the root device name this instance expects; any
other name and it will not boot.

### Step 5: Start and verify

```bash
aws ec2 start-instances --region ap-south-1 --instance-ids i-0b51ab1213d084640
aws ec2 wait instance-running --region ap-south-1 --instance-ids i-0b51ab1213d084640

# Encryption is on and the settings carried over:
aws ec2 describe-volumes --region ap-south-1 --volume-ids "$NEW_VOL_ID" \
  --query 'Volumes[0].{Encrypted:Encrypted,Size:Size,Iops:Iops,Throughput:Throughput}'

# The app is back (give it 2 to 3 minutes for containers to come up):
curl -s -o /dev/null -w "app:    %{http_code}\n" https://events.meetingmindsgroup.com/health
curl -s -o /dev/null -w "worker: %{http_code}\n" https://events.meetingmindsgroup.com/worker/health

# Uploads survived and still serve:
curl -s -o /dev/null -w "photo:  %{http_code}\n" \
  "https://events.meetingmindsgroup.com/uploads/photos/2026/08/291cfdd1-b925-47ec-9b0c-16fe6b3041a3.jpg"

# Private prefixes still refused:
curl -s -o /dev/null -w "private: %{http_code} (expect 403)\n" \
  "https://events.meetingmindsgroup.com/uploads/speaker-docs/x/y.pdf"
```

Then check the containers directly (via SSM):

```bash
docker ps --format "{{.Names}} {{.Status}}"
df -h /
ls /home/ubuntu/ea-sys/public/uploads
```

---

## 6. Failover, in order of cost

### A. Rollback: reattach the original volume (~5 minutes)

The original is untouched and still in the account. This is the answer to almost
any failure: the new volume will not boot, the instance will not start, the
filesystem looks wrong, containers will not come up.

```bash
aws ec2 stop-instances --region ap-south-1 --instance-ids i-0b51ab1213d084640
aws ec2 wait instance-stopped --region ap-south-1 --instance-ids i-0b51ab1213d084640

aws ec2 detach-volume --region ap-south-1 --volume-id "$NEW_VOL_ID"
aws ec2 wait volume-available --region ap-south-1 --volume-ids "$NEW_VOL_ID"

aws ec2 attach-volume --region ap-south-1 \
  --volume-id vol-073ca563deaa8732a --instance-id i-0b51ab1213d084640 --device /dev/sda1

aws ec2 start-instances --region ap-south-1 --instance-ids i-0b51ab1213d084640
```

You are exactly where you started, unencrypted, with nothing lost.

### B. Rebuild from the in-window snapshot (~15 minutes)

Only needed if the original volume is somehow also unusable, which this
procedure cannot cause. Create a volume from `$SNAP` in `ap-south-1b` and attach
it as `/dev/sda1`.

### C. Full rebuild from DR (hours)

If the instance itself is lost. `docs/FROM_SCRATCH_REBUILD.md` plus
`infra/dr/README.md`. Uploads and `.env` restore from the Singapore bucket, the
database is Supabase and untouched. This is the existing DR story and this
procedure does not change it.

### What cannot be rolled back

Only the final cleanup in §7. Until you delete the old volume, every path above
stays open.

---

## 7. Afterwards

**Keep the old volume for at least a week**, two if the calendar is clear. It is
your rollback. At 50 GB gp3 it costs roughly $4/month, which is nothing against
the option value.

**Check `DeleteOnTermination`.** The original root had it set to `true`. A volume
attached afterwards defaults to `false`, which is safer during the bake (an
accidental terminate leaves the disk behind rather than destroying it). Decide
deliberately rather than inheriting it:

```bash
aws ec2 describe-instances --region ap-south-1 --instance-ids i-0b51ab1213d084640 \
  --query 'Reservations[0].Instances[0].BlockDeviceMappings[0].Ebs.DeleteOnTermination'
```

**Delete the unencrypted snapshots.** There are three by the end: the April one
(`snap-08e84992f929dc0b4`), the warm-up, and the in-window `$SNAP`. All are full
plaintext copies of the same data, so leaving them keeps the finding alive.
Delete them once the bake period ends, not before, since `$SNAP` is rollback
path B.

**Update the questionnaire.** `SECURITY_AND_PRIVACY_POSTURE.md` §0.2, §3 and §9
all currently say the disk is unencrypted.

---

## 8. Known surprises

**The box will be slow for a while after booting.** A volume restored from a
snapshot loads blocks from S3 lazily on first access. It is not broken; it is
warming. It resolves as the working set is touched. Fast Snapshot Restore
removes this and costs money by the hour, which is not worth it for a one-off.

**This has never been drilled on this box.** The steps are standard AWS and the
rollback is sound in principle, but the procedure is unverified here. That is an
argument for a quiet window and for reading §6 before starting, not against
doing it.

**The public IP does not change.** An Elastic IP is attached, so DNS needs no
change. If that EIP is ever released, this assumption breaks.

**The short path depends on an account-level setting.** If default EBS encryption
is ever turned off, §5 step 3 silently produces an unencrypted volume. That is
why the step checks `Enc` in the response instead of assuming.
