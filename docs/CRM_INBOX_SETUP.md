# CRM Inbox — SES inbound setup (operator runbook)

**Status: code shipped July 23, 2026 — DORMANT until the steps below are done.**
Until then, CRM sends behave exactly as before (no tokenized Reply-To), and the
Inbox tab shows outbound sent-history only.

## What this enables

Every email sent from the CRM (deal Email button, sponsor blasts, inbox
replies) carries a tokenized `Reply-To` like `a1b2…@reply.meetingmindsdubai.com`.
When the sponsor hits reply, SES receives it, writes the raw MIME to S3, and the
`crm-inbound-email` worker job (every minute) files it into the right thread in
**CRM → Inbox** — bell-notifying and forward-copying the deal owner.

```
sponsor replies → MX → SES inbound (ap-south-1) → s3://BUCKET/inbound/
                                   → worker parses + threads → CRM Inbox
```

Nothing about the org's real mail changes: `partnerships@meetingmindsdubai.com`
and every other M365 mailbox is untouched — only the NEW `reply.` subdomain
routes to SES.

## Decisions locked (July 23, 2026)

- Intake: **SES inbound** on `reply.meetingmindsdubai.com` (M365 IMAP/Graph
  rejected — Azure app registration + consent is more setup and more fragile).
- Visibility: **shared inbox** for CRM staff (ADMIN / SUPER_ADMIN / ORGANIZER /
  CRM_USER). MEMBER never sees it (`canViewCrmInbox` — sponsor-side accounts
  must not read rival negotiations).
- **Forward-copy** each inbound reply to the deal owner's real mailbox.

## One-time setup (run these yourself — AWS mutations are operator-run)

All in **ap-south-1** (SES receiving verified available there; keeps everything
in Mumbai). Pick the bucket name once and keep it consistent.

### 1. S3 bucket + SES write permission

```bash
aws s3api create-bucket --bucket ea-sys-crm-inbound --region ap-south-1 \
  --create-bucket-configuration LocationConstraint=ap-south-1

aws s3api put-bucket-policy --bucket ea-sys-crm-inbound --region ap-south-1 --policy '{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "AllowSESPuts",
    "Effect": "Allow",
    "Principal": { "Service": "ses.amazonaws.com" },
    "Action": "s3:PutObject",
    "Resource": "arn:aws:s3:::ea-sys-crm-inbound/inbound/*",
    "Condition": { "StringEquals": { "aws:SourceAccount": "803726282629" } }
  }]
}'

# Processed/quarantined/unmatched mail expires after 90 days (the parsed
# content lives in Postgres; S3 is the raw-MIME audit copy).
aws s3api put-bucket-lifecycle-configuration --bucket ea-sys-crm-inbound --region ap-south-1 \
  --lifecycle-configuration '{
    "Rules": [
      { "ID": "expire-processed",  "Status": "Enabled", "Filter": { "Prefix": "processed/" },  "Expiration": { "Days": 90 } },
      { "ID": "expire-quarantine", "Status": "Enabled", "Filter": { "Prefix": "quarantine/" }, "Expiration": { "Days": 90 } },
      { "ID": "expire-unmatched",  "Status": "Enabled", "Filter": { "Prefix": "unmatched/" },  "Expiration": { "Days": 90 } }
    ]
  }'
```

### 2. DNS — one MX record on the subdomain

Wherever `meetingmindsdubai.com` DNS is hosted, add:

| Host                          | Type | Value                                    | TTL  |
|-------------------------------|------|------------------------------------------|------|
| `reply.meetingmindsdubai.com` | MX   | `10 inbound-smtp.ap-south-1.amazonaws.com` | 3600 |

This does NOT touch the root domain's MX (your M365 mail is unaffected).

### 3. SES receipt rule

There is currently **no active receipt rule set** in ap-south-1 (verified empty
July 23, 2026), so activating this one replaces nothing.

```bash
aws ses create-receipt-rule-set --rule-set-name ea-sys-crm-inbound --region ap-south-1

aws ses create-receipt-rule --rule-set-name ea-sys-crm-inbound --region ap-south-1 --rule '{
  "Name": "crm-reply-to-s3",
  "Enabled": true,
  "Recipients": ["reply.meetingmindsdubai.com"],
  "ScanEnabled": true,
  "Actions": [{ "S3Action": { "BucketName": "ea-sys-crm-inbound", "ObjectKeyPrefix": "inbound/" } }]
}'

aws ses set-active-receipt-rule-set --rule-set-name ea-sys-crm-inbound --region ap-south-1
```

`ScanEnabled: true` is what stamps the `X-SES-Spam-Verdict` / `X-SES-Virus-Verdict`
headers the worker's quarantine gate reads.

### 4. IAM — let the worker read + move objects

Add an inline policy to `ea-sys-mumbai-ec2-role`:

```bash
aws iam put-role-policy --role-name ea-sys-mumbai-ec2-role \
  --policy-name CrmInboundEmailS3 --policy-document '{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["s3:ListBucket"], "Resource": "arn:aws:s3:::ea-sys-crm-inbound" },
    { "Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::ea-sys-crm-inbound/*" }
  ]
}'
```

### 5. Env + restart

On the box, add to `/home/ubuntu/ea-sys/.env`:

```
CRM_REPLY_DOMAIN="reply.meetingmindsdubai.com"
CRM_INBOUND_S3_BUCKET="ea-sys-crm-inbound"
CRM_INBOUND_S3_REGION="ap-south-1"
```

Then `bash scripts/deploy.sh` (containers must restart to read the new env —
web for the Reply-To on sends, worker for the S3 poller).

## Verify

1. `dig MX reply.meetingmindsdubai.com` → the SES endpoint.
2. Send any email to `test@reply.meetingmindsdubai.com` → within ~2 min the
   object should appear under `unmatched/` in the bucket (token doesn't match a
   thread — correct) and `/logs` shows `crm-inbound:unmatched`.
3. Real flow: open a deal → Email → send to yourself → reply from your mailbox
   → within ~1 min the thread in **CRM → Inbox** shows the reply, the deal
   History gets "Email reply received", and the deal owner gets the bell + a
   `Fwd:` copy.

## Operational notes

- The worker job is `crm-inbound-email` (JOB_ID 1012, every minute) — visible on
  `/worker/health` and in `/logs` (search `crm-inbound:`).
- `quarantine/` holds SES spam/virus FAILs (never filed, never notified);
  `unmatched/` holds mail with no resolvable thread token. Both auto-expire.
- Emails sent BEFORE the env landed carry no tokenized Reply-To — replies to
  those go wherever they went before (the from address), not into the inbox.
- Known v1 limitation: replies sent from the CRM don't set RFC threading
  headers (`In-Reply-To`/`References`) — clients group by subject+participants.
  The Message-ID chain is stored for a future upgrade.
