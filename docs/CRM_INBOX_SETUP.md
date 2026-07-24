# CRM Inbox — SES inbound setup (operator runbook)

**Status: configured on prod July 24, 2026 — the AWS/DNS pipeline below is live
(`reply.meetingmindsexperts.com`).** Before the env in Step 5 lands, CRM sends
behave as before (no tokenized Reply-To) and the Inbox tab shows outbound
sent-history only; after it, replies thread.

## What this enables

Every email sent from the CRM (deal **Email** button + sponsor blasts) carries a
tokenized `Reply-To` like `a1b2…@reply.meetingmindsexperts.com`. When the sponsor
hits reply, SES receives it, writes the raw MIME to S3, and the
`crm-inbound-email` worker job (every minute) files it into the right thread in
**CRM → Inbox** — bell-notifying and forward-copying the deal owner.

The **Inbox is read-only** (owner decision): it's where incoming replies land and
are read; you never compose there. Sending is centralized on the **deal's Email
action** — open the deal and email the contact. So one deal email + its reply
form a thread; a fresh response is a new deal email (a new thread).

```
sponsor replies → MX → SES inbound (ap-south-1) → s3://ea-sys-crm-inbound/inbound/
                                   → worker parses + threads → CRM Inbox
```

Nothing about the org's real mail changes — only the NEW `reply.` subdomain
routes to SES; every existing mailbox on `meetingmindsexperts.com` is untouched.

## Decisions locked (July 2026)

- Intake: **SES inbound** on `reply.meetingmindsexperts.com` (M365 IMAP/Graph
  rejected — Azure app registration + consent is more setup and more fragile).
  Chose `meetingmindsexperts.com` because its parent domain is **already a
  verified SES sending identity** in ap-south-1, so replies align with the From
  address.
- Visibility: **shared inbox** for CRM staff (ADMIN / SUPER_ADMIN / ORGANIZER /
  CRM_USER). MEMBER never sees it (`canViewCrmInbox` — sponsor-side accounts
  must not read rival negotiations).
- **Forward-copy** each inbound reply to the deal owner's real mailbox.

> **You do NOT verify an SES identity for the reply subdomain.** Identity /
> DKIM verification is a *sending* concept. SES email **receiving** is gated
> only by the MX record + an active receipt rule — the MX proves you own the
> subdomain (only you can set its DNS). Don't create an SES domain identity for
> `reply.…` — it's unnecessary and errors.

## As-built config (prod)

| Thing | Value |
|---|---|
| Region | `ap-south-1` (Mumbai) |
| Account | `803726282629` |
| Reply subdomain | `reply.meetingmindsexperts.com` |
| S3 bucket | `ea-sys-crm-inbound` |
| SES rule set / rule | `ea-sys-crm-inbound` / `crm-reply-to-s3` (Active) |
| IAM inline policy | `CrmInboundEmailS3` on `ea-sys-mumbai-ec2-role` |
| Worker job | `crm-inbound-email` (JOB_ID 1012, every minute) |
| Outbound From | `Partnerships <partnerships@meetingmindsdubai.com>` |

## CRM sender identity (outbound From)

CRM outbound (deal emails + sponsor blasts) sends **From** its own identity, not
the platform default `EMAIL_FROM` (which still brands registration confirmations
etc.). Set by env:

```
CRM_EMAIL_FROM_NAME="Partnerships"
CRM_EMAIL_FROM_ADDRESS="partnerships@meetingmindsdubai.com"
```

- The address **MUST be an SES-verified identity** in `ap-south-1` or SES rejects
  the send (`MessageRejected`). `partnerships@meetingmindsdubai.com` is verified
  as an **email identity** (July 24, 2026). Reply-To is unaffected — it stays the
  tokenized inbox address, so replies still thread.
- **Deliverability:** email-identity verification has no DKIM, so mail From
  `@meetingmindsdubai.com` may hit some sponsors' spam. For real outreach volume,
  upgrade to full **domain** verification of `meetingmindsdubai.com` (Easy DKIM
  CNAMEs) — that gives DKIM/DMARC alignment. See `crmSenderFrom()` in
  `src/crm/services/sponsor-email-service.ts` for the precedence (CRM env → the
  deal's linked-event sender → global `EMAIL_FROM`).

## One-time setup (operator-run — AWS mutations are hand-run, CLI or Console)

All in **ap-south-1**. Keep the bucket name identical across every step. *(A
dropped character once created a `a-sys-crm-inbound` bucket — the policy then
failed "invalid resource" because its ARNs referenced a bucket that didn't
exist. Recreate with the right name rather than carrying a typo through SES +
IAM + env.)*

### 1. S3 bucket — hardened

```bash
aws s3api create-bucket --bucket ea-sys-crm-inbound --region ap-south-1 \
  --create-bucket-configuration LocationConstraint=ap-south-1

# Block ALL public access
aws s3api put-public-access-block --bucket ea-sys-crm-inbound \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

# Default encryption (SSE-S3)
aws s3api put-bucket-encryption --bucket ea-sys-crm-inbound \
  --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'

# Policy: SES may write inbound/ (scoped to this account); deny non-TLS.
aws s3api put-bucket-policy --bucket ea-sys-crm-inbound --policy '{
  "Version":"2012-10-17",
  "Statement":[
    {"Sid":"AllowSESPuts","Effect":"Allow","Principal":{"Service":"ses.amazonaws.com"},
     "Action":"s3:PutObject","Resource":"arn:aws:s3:::ea-sys-crm-inbound/inbound/*",
     "Condition":{"StringEquals":{"aws:SourceAccount":"803726282629"}}},
    {"Sid":"DenyInsecureTransport","Effect":"Deny","Principal":"*","Action":"s3:*",
     "Resource":["arn:aws:s3:::ea-sys-crm-inbound","arn:aws:s3:::ea-sys-crm-inbound/*"],
     "Condition":{"Bool":{"aws:SecureTransport":"false"}}}
  ]}'

# Processed/quarantined/unmatched mail expires after 90 days (parsed content
# lives in Postgres; S3 keeps the raw-MIME audit copy).
aws s3api put-bucket-lifecycle-configuration --bucket ea-sys-crm-inbound \
  --lifecycle-configuration '{"Rules":[
    {"ID":"exp-processed","Status":"Enabled","Filter":{"Prefix":"processed/"},"Expiration":{"Days":90}},
    {"ID":"exp-quarantine","Status":"Enabled","Filter":{"Prefix":"quarantine/"},"Expiration":{"Days":90}},
    {"ID":"exp-unmatched","Status":"Enabled","Filter":{"Prefix":"unmatched/"},"Expiration":{"Days":90}}
  ]}'
```

### 2. DNS — one MX record on the subdomain

On the `meetingmindsexperts.com` DNS host, add:

| Host | Type | Value | TTL |
|---|---|---|---|
| `reply.meetingmindsexperts.com` | MX | `10 inbound-smtp.ap-south-1.amazonaws.com` | 3600 |

Priority value doesn't matter for a single record. This does NOT touch the root
domain's MX (existing mail unaffected).

### 3. SES receipt rule (no identity step — see the callout above)

```bash
aws ses create-receipt-rule-set --rule-set-name ea-sys-crm-inbound --region ap-south-1

aws ses create-receipt-rule --rule-set-name ea-sys-crm-inbound --region ap-south-1 --rule '{
  "Name":"crm-reply-to-s3","Enabled":true,
  "Recipients":["reply.meetingmindsexperts.com"],"ScanEnabled":true,
  "Actions":[{"S3Action":{"BucketName":"ea-sys-crm-inbound","ObjectKeyPrefix":"inbound/"}}]
}'

# CRITICAL — an inactive rule set does nothing:
aws ses set-active-receipt-rule-set --rule-set-name ea-sys-crm-inbound --region ap-south-1
```

`ScanEnabled: true` stamps the `X-SES-Spam-Verdict` / `X-SES-Virus-Verdict`
headers the worker's quarantine gate reads. On first activation SES drops one
`AMAZON_SES_SETUP_NOTIFICATION` object into `inbound/` as a write-permission
test — the worker files it to `unmatched/` (no token). Its presence confirms
the SES → S3 leg works.

### 4. IAM — let the worker read + move objects

```bash
aws iam put-role-policy --role-name ea-sys-mumbai-ec2-role \
  --policy-name CrmInboundEmailS3 --policy-document '{
  "Version":"2012-10-17",
  "Statement":[
    {"Effect":"Allow","Action":["s3:ListBucket"],"Resource":"arn:aws:s3:::ea-sys-crm-inbound"},
    {"Effect":"Allow","Action":["s3:GetObject","s3:PutObject","s3:DeleteObject"],"Resource":"arn:aws:s3:::ea-sys-crm-inbound/*"}
  ]}'
```

### 5. Env + deploy (on the box)

Append to `/home/ubuntu/ea-sys/.env` (do NOT overwrite the existing file):

```
CRM_REPLY_DOMAIN="reply.meetingmindsexperts.com"
CRM_INBOUND_S3_BUCKET="ea-sys-crm-inbound"
CRM_INBOUND_S3_REGION="ap-south-1"
```

Then `bash scripts/deploy.sh` — the container restart is what makes the web tier
set the Reply-To and the worker start polling. A plain `docker restart` does NOT
re-read `.env`; it must be `deploy.sh`.

## Verify

1. `dig MX reply.meetingmindsexperts.com` → the SES endpoint.
2. `aws s3 ls s3://ea-sys-crm-inbound/inbound/` should drain to empty within ~1
   min of a healthy worker (objects move to `unmatched/`/`processed/`). `/logs`
   (search `crm-inbound:`) or `/worker/health` shows the job ticking.
3. Send any email to `test@reply.meetingmindsexperts.com` → within ~2 min it
   lands under `unmatched/` (no thread token — correct) with `crm-inbound:unmatched`.
4. Real flow: open a deal → **Email** → send to yourself → reply from your
   mailbox → within ~1 min the reply shows in **CRM → Inbox**, the deal History
   gets "Email reply received", and the deal owner gets a bell + a `Fwd:` copy.

## Operational notes

- `quarantine/` holds SES spam/virus FAILs (never filed, never notified);
  `unmatched/` holds mail with no resolvable/active thread token (revoked or
  expired tokens land here too). Both auto-expire at 90 days.
- Anti-spoofing (review H1): an inbound whose From doesn't verify against the
  thread's counterparty (domain mismatch / DMARC fail) is stored + badged
  **Unverified sender**, and its auto-forward to the owner's mailbox is
  suppressed. Watch for `crm-inbound:unverified-sender` in `/logs`.
- Token lifecycle (review M1): tokens roll a 180-day expiry on every message and
  are revoked when a deal is archived — inbound to a dead thread goes `unmatched/`.
- Emails sent BEFORE the env landed carry no tokenized Reply-To — replies to
  those go to the From address, not the inbox.
- Known v1 limitation: replies from the CRM don't set RFC threading headers
  (`In-Reply-To`/`References`) — clients group by subject+participants. The
  Message-ID chain is stored for a future upgrade.
