# Encrypting the EC2 root volume

**Status:** not yet performed. Written 2026-08-19, verified against live state.
**Why:** the root volume is `Encrypted: false`, which is the weakest answer on
the client security questionnaire (`SECURITY_AND_PRIVACY_POSTURE.md` §0.2).
**Downtime:** 20 to 40 minutes, planned.

---

## 0. The one property that makes this safe

**Nothing in this procedure modifies the original volume.** A snapshot is a
read. Copying a snapshot is a read. The encrypted volume is a new object. The
original is detached, not erased, and it stays in the account until you
explicitly delete it.

So at every step before the final cleanup, **rollback is reattaching the volume
you already have**, and it takes about five minutes. That is the failover
strategy, and it is stronger than any backup because the original disk itself is
sitting there intact.

---

## 1. Verified live state (2026-08-19)

| Item | Value |
|---|---|
| Instance | `i-0b51ab1213d084640`, `t3.large`, `ap-south-1b` |
| Root volume | `vol-073ca563deaa8732a` |
| Size / type | 50 GB, **gp3**, **3000 IOPS**, **125 MB/s** |
| Root device name | `/dev/sda1` |
| Encrypted | **false** |
| DeleteOnTermination | **true** (see §6) |
| Elastic IP | `3.108.247.193`, **attached** — survives stop/start, DNS does not change |
| KMS keys present | only `alias/aws/ebs` (AWS-managed) |

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

---

## 3. Pre-flight (do not skip)

```bash
# 1. No live event in the window. Check the events calendar. A conference
#    morning is the wrong time: check-in, badges and the kiosk all go down.

# 2. DR is current.
aws s3 ls s3://ea-sys-dr-singapore/db/ --recursive --region ap-southeast-1 | tail -2
#    Expect a dump from within the last hour.

# 3. Record the current state so you can compare afterwards.
aws ec2 describe-volumes --region ap-south-1 --volume-ids vol-073ca563deaa8732a \
  --query 'Volumes[0].{Size:Size,Type:VolumeType,Iops:Iops,Throughput:Throughput,AZ:AvailabilityZone}'

# 4. Confirm the Elastic IP is still attached (it is what keeps DNS working).
aws ec2 describe-addresses --region ap-south-1 \
  --query 'Addresses[?InstanceId==`i-0b51ab1213d084640`].PublicIp' --output text
```

**Announce the window.** Public registration, the dashboard, check-in, the
kiosk, webinar join pages, the MCP endpoint and all background jobs are down for
the duration. Stripe retries failed webhooks for three days and the
invoice-reconciliation worker catches stragglers, so payments landing mid-window
settle late rather than being lost.

---

## 4. The procedure

### Step 1 — Stop the instance

```bash
aws ec2 stop-instances --region ap-south-1 --instance-ids i-0b51ab1213d084640
aws ec2 wait instance-stopped --region ap-south-1 --instance-ids i-0b51ab1213d084640
```

Stopping first gives a filesystem-consistent snapshot. The database is Supabase
and lives off the box, so nothing transactional is at risk either way.

### Step 2 — Snapshot the volume

```bash
SNAP=$(aws ec2 create-snapshot --region ap-south-1 \
  --volume-id vol-073ca563deaa8732a \
  --description "pre-encryption root snapshot $(date -u +%FT%TZ)" \
  --query 'SnapshotId' --output text)
echo "SNAP=$SNAP"
aws ec2 wait snapshot-completed --region ap-south-1 --snapshot-ids "$SNAP"
```

This snapshot is your second rollback path. Keep it.

### Step 3 — Copy the snapshot, encrypted

```bash
ENC_SNAP=$(aws ec2 copy-snapshot --region ap-south-1 \
  --source-region ap-south-1 --source-snapshot-id "$SNAP" \
  --encrypted --kms-key-id alias/aws/ebs \
  --description "encrypted root snapshot" \
  --query 'SnapshotId' --output text)
echo "ENC_SNAP=$ENC_SNAP"
aws ec2 wait snapshot-completed --region ap-south-1 --snapshot-ids "$ENC_SNAP"
```

This is the slow step: a full re-encrypt of 50 GB, not an incremental copy.
Budget 5 to 15 minutes.

### Step 4 — Create the encrypted volume, same AZ, same settings

```bash
NEW_VOL=$(aws ec2 create-volume --region ap-south-1 \
  --snapshot-id "$ENC_SNAP" \
  --availability-zone ap-south-1b \
  --volume-type gp3 --iops 3000 --throughput 125 \
  --query 'VolumeId' --output text)
echo "NEW_VOL=$NEW_VOL"
aws ec2 wait volume-available --region ap-south-1 --volume-ids "$NEW_VOL"
```

**The AZ must be `ap-south-1b`.** A volume in another AZ cannot attach, and the
error arrives only at attach time.

### Step 5 — Swap

```bash
aws ec2 detach-volume --region ap-south-1 --volume-id vol-073ca563deaa8732a
aws ec2 wait volume-available --region ap-south-1 --volume-ids vol-073ca563deaa8732a

aws ec2 attach-volume --region ap-south-1 \
  --volume-id "$NEW_VOL" --instance-id i-0b51ab1213d084640 --device /dev/sda1
aws ec2 wait volume-in-use --region ap-south-1 --volume-ids "$NEW_VOL"
```

**`/dev/sda1` exactly.** That is the root device name this instance expects; any
other name and it will not boot.

### Step 6 — Start and verify

```bash
aws ec2 start-instances --region ap-south-1 --instance-ids i-0b51ab1213d084640
aws ec2 wait instance-running --region ap-south-1 --instance-ids i-0b51ab1213d084640

# Encryption is on:
aws ec2 describe-volumes --region ap-south-1 --volume-ids "$NEW_VOL" \
  --query 'Volumes[0].{Encrypted:Encrypted,Iops:Iops,Throughput:Throughput}'

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

Then check the containers directly:

```bash
# via SSM
docker ps --format "{{.Names}} {{.Status}}"
df -h /
ls /home/ubuntu/ea-sys/public/uploads
```

---

## 5. Failover, in order of cost

### A. Rollback: reattach the original volume (~5 minutes)

The original is untouched and still in the account. This is the answer to almost
any failure: the new volume will not boot, the instance will not start, the
filesystem looks wrong, containers will not come up.

```bash
aws ec2 stop-instances --region ap-south-1 --instance-ids i-0b51ab1213d084640
aws ec2 wait instance-stopped --region ap-south-1 --instance-ids i-0b51ab1213d084640

aws ec2 detach-volume --region ap-south-1 --volume-id "$NEW_VOL"
aws ec2 wait volume-available --region ap-south-1 --volume-ids "$NEW_VOL"

aws ec2 attach-volume --region ap-south-1 \
  --volume-id vol-073ca563deaa8732a --instance-id i-0b51ab1213d084640 --device /dev/sda1

aws ec2 start-instances --region ap-south-1 --instance-ids i-0b51ab1213d084640
```

You are exactly where you started, unencrypted, with nothing lost.

### B. Rebuild from the pre-encryption snapshot (~15 minutes)

Only needed if the original volume is somehow also unusable, which this
procedure cannot cause. Create a volume from `$SNAP` in `ap-south-1b` and attach
it as `/dev/sda1`.

### C. Full rebuild from DR (hours)

If the instance itself is lost. `docs/FROM_SCRATCH_REBUILD.md` plus
`infra/dr/README.md`. Uploads and `.env` restore from the Singapore bucket, the
database is Supabase and untouched. This is the existing DR story and this
procedure does not change it.

### What cannot be rolled back

Only the final cleanup in §6. Until you delete the old volume, every path above
stays open.

---

## 6. Afterwards

**Keep the old volume for at least a week.** It is your rollback. At 50 GB gp3
it costs roughly $4/month, which is nothing against the option value.

**Check `DeleteOnTermination`.** The original root had it set to `true`. A volume
attached afterwards defaults to `false`, which is safer during the bake (an
accidental terminate leaves the disk behind rather than destroying it). Decide
deliberately rather than inheriting it:

```bash
aws ec2 describe-instances --region ap-south-1 --instance-ids i-0b51ab1213d084640 \
  --query 'Reservations[0].Instances[0].BlockDeviceMappings[0].Ebs.DeleteOnTermination'
```

**Turn on default encryption for future volumes** so a rebuilt box is encrypted
without anyone remembering:

```bash
aws ec2 enable-ebs-encryption-by-default --region ap-south-1
```

**Deal with the old unencrypted snapshots.** The April snapshot
(`snap-08e84992f929dc0b4`) and `$SNAP` from this procedure are unencrypted
copies of the same data. Leaving them around keeps the finding alive. Delete
them once the bake period ends.

**Update the questionnaire.** `SECURITY_AND_PRIVACY_POSTURE.md` §0.2, §3 and §9
all currently say the disk is unencrypted.

---

## 7. Known surprises

**The box will be slow for a while after booting.** A volume restored from a
snapshot loads blocks from S3 lazily on first access. It is not broken; it is
warming. It resolves as the working set is touched. Fast Snapshot Restore
removes this and costs money by the hour, which is not worth it for a one-off.

**This has never been drilled on this box.** The steps are standard AWS and the
rollback is sound in principle, but the procedure is unverified here. That is an
argument for a quiet window and for reading §5 before starting, not against
doing it.

**The public IP does not change.** An Elastic IP is attached, so DNS needs no
change. If that EIP is ever released, this assumption breaks.
