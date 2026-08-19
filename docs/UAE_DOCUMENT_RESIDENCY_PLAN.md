# UAE document residency — plan

**Status:** PLANNED, not built. Awaiting sign-off.
**Date:** 2026-08-19
**Goal:** every uploaded file lives in AWS `me-central-1` (UAE). Compute and
database do not move.

---

## 1. The decision, and what it deliberately does not do

Emirates Health Services asked where data is hosted, and identity documents
(passports, Emirates IDs, CVs) are about to start arriving through the speaker
document form. The aim is that those files are stored in the UAE.

**Compute stays in Mumbai.** This is the central design choice and it is what
makes the plan cheap. Document residency and compute residency are separable:
object storage is not on any hot path, so the files can move to Dubai while the
application stays next to its database in `ap-south-1`.

**The database is not in scope, and cannot be.** Supabase offers 16 regions and
none is in the Middle East (verified 2026-08-19 against their region docs).
Mumbai is the closest available region, so the current placement is already the
best reachable one. Moving registration data into the UAE would mean leaving
Supabase for RDS in `me-central-1`. That is a separate project and should only
start if a client or a lawyer says it is required.

**Moving EC2 alone was considered and rejected.** EC2 and Supabase are both in
`ap-south-1` today, so a database round trip is 1 to 2ms. Dubai to Mumbai is
roughly 35ms. Application-to-database latency multiplies (one page view is many
queries) while user-to-application latency does not (one page view is one round
trip). Moving the box alone would make every query about twenty times slower to
buy a partial residency answer. It is the worst available configuration.

### Residency after this change

| Data | Where it lives now | After |
|---|---|---|
| Uploaded files (all categories) | Mumbai EC2 disk | **UAE (`me-central-1`)** |
| Backup of uploaded files | Singapore S3 | **UAE, same region** |
| Registration / contact data | Supabase Mumbai | Supabase Mumbai (unchanged) |
| Database dumps | Singapore S3 | Singapore S3 (unchanged) |
| `.env`, break-glass box | Singapore | Singapore (unchanged) |
| Email in transit | SES Mumbai | SES Mumbai (unchanged) |

**Backup follows the primary's jurisdiction.** The database is in India, so a
Singapore backup does not change its residency story and Singapore remains the
DR constant for it. The document bucket is the one exception: its primary would
genuinely be in the UAE, so replicating it to Singapore would break a claim that
is otherwise clean and true.

---

## 2. What the survey found

The storage abstraction in [src/lib/storage.ts](../src/lib/storage.ts) supports
`local` and `supabase` providers, and it covers **photos, media, certificate
PDFs and Stripe receipts only**.

Every document feature built after it writes to `public/uploads/` directly with
`writeFile`, bypassing the abstraction entirely:

| Feature | Prefix | Sensitivity |
|---|---|---|
| Speaker documents (organiser upload) | `speaker-docs/` | **Passport, CV** |
| **Speaker profile form (public, token)** | `speaker-docs/` | **Passport, CV** |
| Reimbursement documents (organiser + public) | `reimbursements/` | **Passport, bank details** |
| Registration supporting documents | derived constant | Employer letter, signature, stamp |
| CRM deal documents | `crm-deal-docs/` | Contracts, quotes with deal money |
| CRM inbound email attachments | `crm-email-attachments/` | Third-party files |
| Speaker agreement templates + letterheads | `agreements/` | Not personal |
| Certificate background PDFs | `certificates/` | Not personal |

That is nine hand-rolled write sites repeating the same `mkdir` plus UUID plus
`writeFile` pattern, and roughly a dozen read sites. **The sensitive files are
exactly the ones that skipped the abstraction.**

This is the reason for Phase 1 below. Switching provider in one place is a
config change; switching it in twenty is a migration with twenty chances to miss
one, and a missed private write site would leave passports on the Mumbai disk
while the residency claim said otherwise.

### Current on-disk inventory (prod, 2026-08-19)

```
photos            404 files   27M
media              66 files   24M
certificates       38 files   14M
agreements          4 files  336K
stripe-receipts     2 files  104K
crm-deal-docs       1 file    20K
```

No `speaker-docs/`, no `reimbursements/`, no supporting-document directory.
**Nothing sensitive has ever been uploaded.** This is work done ahead of the
problem rather than after it, which is the good case: no sensitive file ever has
to be migrated out of the wrong jurisdiction or purged from Singapore.

---

## 3. Architecture

### Bucket

One bucket, `me-central-1`, holding every category. A single central store was
chosen over per-category routing because it is **less** code, not more: routing
needs a category-to-provider map, moving everything needs none.

| Setting | Value | Why |
|---|---|---|
| Region | `me-central-1` | The requirement |
| Block Public Access | all four ON | The critical control, see §6 |
| Versioning | Enabled | Recovers deleted objects; the INC-004 lesson about shared paths |
| Encryption | SSE-KMS, customer-managed key **in `me-central-1`** | KMS keys are regional; the Singapore key cannot be reused |
| Replication | Same-region, to a second UAE bucket | DR without leaving the UAE |

**"DR in the UAE" cannot mean cross-region, because AWS has one UAE region.**
S3 already replicates across three availability zones inside a region at eleven
nines of durability, so hardware loss is not the exposure. The real risks are
accidental deletion and a bad bucket policy, and versioning plus same-region
replication cover both while staying inside the country. A full regional outage
remains uncovered, which is the same exposure the EC2 box already carries.

### Keys keep the existing URL shape

Database columns store paths like `/uploads/photos/2026/08/{uuid}.jpg`. The S3
key is the same string with the leading `/uploads/` removed.

**No stored value changes, so there is no data migration.** Only the backing
store changes. This removes the largest category of risk from the project.

### Serving model

Private documents keep streaming through the existing authenticated routes,
which read from S3 instead of disk. Authorisation logic is untouched, no
presigned URLs, no new public surface. One Dubai-to-Mumbai hop per download on a
path that is hit rarely.

Public assets (photos, media) also stream through the app, as they already do
today via the catch-all route. **This costs latency and it is an accepted
trade.** A speakers list with 50 photos currently reads from local disk in about
0ms per file; afterwards each is a Mumbai-to-Dubai fetch, so first load gains
roughly half a second before the existing one-year cache headers take over.

CloudFront in front of the public prefixes would remove that. It is deliberately
**not** in this plan: measure first, and putting a CDN in front of a bucket that
also holds passports adds a misconfiguration path that has to be worth paying
for.

### The designated fallback if the measurement comes back slow

Decided 2026-08-19: **not built up front, held as a fallback.** If the Phase 0
measurement shows a round trip materially worse than the published ~33ms, or if
image-heavy pages are visibly slow after cutover, the fix is a **read-through
disk cache**: fetch an object from the bucket once, keep a copy on the local
disk, serve every subsequent request at disk speed. It costs about 51 MB and
removes nearly all of the image latency.

**The rule that makes it safe: public prefixes only, never private documents.**
A speaker photo on the public agenda is already on the open internet, so a copy
in Mumbai changes nothing about residency. A passport is the opposite. Once this
ships, no private document may touch the Mumbai disk, or the residency claim
collapses. If the cache is ever built, that boundary needs a test, not a
comment.

The reason it is not built now is that the existing one-year `immutable` cache
headers already mean each file is fetched from Dubai once per browser ever, so
the cache may be solving a problem that does not survive contact with real
traffic.

---

## 4. Phases

Each phase is independently deployable and independently revertable.

### Phase 0 — Infrastructure (operator runs, see §5), then measure

Opt in to `me-central-1`, create the KMS key, create both buckets, attach the
IAM policy. Nothing in the application changes.

**Then measure the real round trip before Phase 1 starts.** Every latency figure
in this document is a published estimate (~33ms Mumbai to UAE), not a
measurement from your box. From the EC2 instance, time a small and a large
object round trip against the new bucket:

```bash
# From the box, after the IAM policy is attached. Upload then fetch, timed.
head -c 67000 /dev/urandom > /tmp/probe-small.bin   # ~ average photo
head -c 370000 /dev/urandom > /tmp/probe-large.bin  # ~ average certificate
for f in small large; do
  aws s3 cp /tmp/probe-$f.bin s3://ea-sys-documents-uae/_probe/$f.bin --region me-central-1
  echo "--- $f fetch x5 ---"
  for i in 1 2 3 4 5; do
    /usr/bin/time -f "%e s" aws s3 cp s3://ea-sys-documents-uae/_probe/$f.bin /tmp/out.bin \
      --region me-central-1 2>&1 | tail -1
  done
done
aws s3 rm s3://ea-sys-documents-uae/_probe/ --recursive --region me-central-1
```

**This is a gate, not a formality.** If the numbers come back close to the table
in §3, proceed as planned. If they come back materially worse, the read-through
cache fallback above moves from optional to required, and that decision is
cheaper to make here than after cutover.

### Phase 1 — Consolidate every file operation behind `storage.ts`

No behaviour change. Provider stays `local`. Every write site loses its
hand-rolled `mkdir`/`writeFile` and calls a storage function; every read site
loses its `readFile` and calls `readObject`.

New surface in `storage.ts`:

```ts
uploadFile(buffer, filename, mimeType, subdirectory): Promise<string>
readFile(storedPath): Promise<Buffer>          // throws NotFound
deleteFile(storedPath): Promise<void>          // never throws
exists(storedPath): Promise<boolean>
```

The existing `uploadPhoto` / `uploadMedia` / `uploadCertificatePdf` /
`uploadStripeReceipt` / `deletePhoto` / `deleteMedia` wrappers stay as thin
callers so nothing outside has to change at once.

This phase is worth shipping on its own merits regardless of the UAE decision:
it removes nine copies of the same logic, which is the cross-caller duplication
rule, and it means the next storage change is one file.

**Verification:** full gate (tsc, eslint, vitest, build), plus manual upload and
download of one file per category on the local prod copy.

### Phase 2 — Add the `s3` provider

`STORAGE_PROVIDER=s3` becomes a valid value. Not enabled anywhere yet.
`@aws-sdk/client-s3` is already a dependency. Credentials come from the EC2
instance role, so no keys in `.env`.

Includes an S3 branch in
[src/lib/certificates/pdf-loader.ts](../src/lib/certificates/pdf-loader.ts),
which carries hardened traversal and host-allowlist guards from the June 2026
BLOCKER fix. **Those guards must be preserved, not replaced.** The S3 branch
gets its own equivalent: key must be within the bucket prefix, no `..`, no null
bytes.

**Verification:** unit tests for the provider including the guard cases,
mutation-verified (a test that cannot fail is not load-bearing).

### Phase 3 — Migrate the existing 515 files

An idempotent script copies `public/uploads/**` into the bucket, preserving the
key mapping, then verifies count and per-object size or checksum. Re-runnable.
Writes nothing to the database.

### Phase 4 — Cutover

Set `STORAGE_PROVIDER=s3` on the box and redeploy via `scripts/deploy.sh`.

**Rollback is flipping the variable back**, because the local files are still
there. Files uploaded during S3 mode would not be on local disk, so during a
one-week bake period a nightly S3-to-local pull keeps rollback whole. After the
bake, stop the pull, stop syncing `uploads/` to Singapore, and remove the local
copies.

---

## 5. Infrastructure runbook (operator)

Commands to run, in order. Nothing here is destructive.

```bash
# 1. Opt in to the UAE region (currently not-opted-in)
aws account enable-region --region-name me-central-1
#    Takes a few minutes. Verify:
aws ec2 describe-regions --all-regions --region-names me-central-1 \
  --query 'Regions[0].OptInStatus' --output text

# 2. KMS key, in-region (a Singapore key cannot encrypt a UAE bucket)
aws kms create-key --region me-central-1 \
  --description "EA-SYS document storage (UAE residency)" \
  --key-usage ENCRYPT_DECRYPT --key-spec SYMMETRIC_DEFAULT \
  --query 'KeyMetadata.KeyId' --output text
aws kms create-alias --region me-central-1 \
  --alias-name alias/ea-sys-documents --target-key-id <KEY_ID_FROM_ABOVE>

# 3. Buckets (primary + same-region replica)
aws s3api create-bucket --region me-central-1 --bucket ea-sys-documents-uae \
  --create-bucket-configuration LocationConstraint=me-central-1
aws s3api create-bucket --region me-central-1 --bucket ea-sys-documents-uae-dr \
  --create-bucket-configuration LocationConstraint=me-central-1

# 4. Block public access — THE critical control (both buckets)
for B in ea-sys-documents-uae ea-sys-documents-uae-dr; do
  aws s3api put-public-access-block --region me-central-1 --bucket $B \
    --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
done

# 5. Versioning (required for replication, and the delete-recovery net)
for B in ea-sys-documents-uae ea-sys-documents-uae-dr; do
  aws s3api put-bucket-versioning --region me-central-1 --bucket $B \
    --versioning-configuration Status=Enabled
done

# 6. Default encryption with the customer key
for B in ea-sys-documents-uae ea-sys-documents-uae-dr; do
  aws s3api put-bucket-encryption --region me-central-1 --bucket $B \
    --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"aws:kms","KMSMasterKeyID":"alias/ea-sys-documents"},"BucketKeyEnabled":true}]}'
done
```

Then verify before proceeding:

```bash
aws s3api get-public-access-block --region me-central-1 --bucket ea-sys-documents-uae
aws s3api get-bucket-encryption   --region me-central-1 --bucket ea-sys-documents-uae
aws s3api get-bucket-versioning   --region me-central-1 --bucket ea-sys-documents-uae
```

Still to write once the region is enabled: the same-region replication role and
rule, and the IAM policy granting `ea-sys-mumbai-ec2-role` the following on the
primary bucket only (`s3:PutObject`, `s3:GetObject`, `s3:DeleteObject`,
`s3:ListBucket`) plus `kms:Encrypt`, `kms:Decrypt`, `kms:GenerateDataKey` on the
key. IAM is global, so a Mumbai instance role reaching a UAE bucket is fine.

**Also worth doing at the same time, unrelated to this plan but free:**

```bash
aws ec2 enable-ebs-encryption-by-default --region ap-south-1
aws ec2 enable-ebs-encryption-by-default --region me-central-1
```

---

## 6. Security

**The public-access block replaces a code-level guard.** Today private prefixes
are safe because
[src/app/uploads/[...path]/route.ts](../src/app/uploads/%5B...path%5D/route.ts)
refuses to serve them. Once files live in S3, that protection moves into bucket
configuration. If public access block is ever relaxed, or a bucket policy grants
anonymous read, passports become world-readable. This setting is the single most
important line in the plan.

**Flip the catch-all from a deny-list to an allow-list.** It currently blocks
five named private prefixes, and its own comments acknowledge the failure mode:
add a sixth private prefix without editing this file and it is served publicly,
with no test failing. An allow-list of the genuinely public prefixes (`photos`,
`media`) fails the safe way instead. This should land in Phase 1.

**Preserve the certificate loader's guards.** `pdf-loader.ts` was hardened in
June 2026 after a BLOCKER: arbitrary file read plus SSRF, with the fetched bytes
re-uploaded to a public URL. The S3 branch must not weaken it.

**No presigned URLs for private documents.** Authorisation stays in the
application where the role checks already live.

---

## 7. Risks

| Risk | Mitigation |
|---|---|
| A write site missed in Phase 1 keeps writing to local disk | Phase 1 is a mechanical sweep with a grep-verified file list; a CI guard could forbid `writeFile` outside `storage.ts` |
| Bucket accidentally made public | Public access block at creation; verify commands in §5; consider an AWS Config rule |
| Photo-heavy pages get slower | Accepted and measured; CloudFront available later if it bites |
| Rollback after files exist only in S3 | One-week bake with a nightly S3-to-local pull before deleting local copies |
| KMS key deleted | Key deletion has a mandatory 7 to 30 day waiting period; leave the default |
| Region opt-in has account-level side effects | Opt-in is additive; no existing region is affected |

---

## 8. Explicitly not in scope

- **Moving the EC2 instance.** Compute stays in Mumbai, by design.
- **Moving the database.** No Supabase region in the Middle East.
- **Moving database dumps out of Singapore.** The primary is in India; the
  backup's jurisdiction should follow it, and Singapore stays the DR constant.
- **CloudFront.** Deferred until latency is measured.
- **EBS root volume encryption.** Separate item; the free account-level default
  setting in §5 is worth doing now either way.

---

## 9. Open questions

1. **Bucket naming.** `ea-sys-documents-uae` is a placeholder.
2. **Bake period length** before local copies are deleted. One week proposed.
3. **Same-region replication:** confirmed wanted, or is versioning alone enough
   for a 65 MB dataset that is also reconstructable from nothing for the
   non-personal categories?
4. **The EHS answer.** Documents will be collected through the speaker document
   form, so they will be stored in the platform. Once this ships, the honest
   answer is that identity documents are stored encrypted in the UAE. Before it
   ships, the honest answer is that they are stored encrypted in Mumbai. The
   email to Medhat should say whichever is true on the day it is sent.
