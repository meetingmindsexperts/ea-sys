# Runbook — AWS SES email failures

**Use when:** `/logs` or Sentry shows `UnrecognizedClientException`,
`AccessDenied`, `MessageRejected`, or any other AWS SDK error from a
`sendEmail` call. Also use this when emails are silently failing — rows
appearing in `EmailLog` with `status='FAILED'` and an AWS error name in
`errorMessage`.

EA-SYS sends through **AWS SES v2 (`ap-south-1`, Bahrain region — sender
domain `meetingmindsexperts.com`)** since the May 21 2026 cutover. The
SDK lives in [src/lib/email.ts](../src/lib/email.ts).

---

## TL;DR triage

Each SES failure tells you which class it is by `awsErrorName` in the
log. The same error code maps to the same fix every time:

| `awsErrorName` | Meaning | Fix |
|---|---|---|
| `UnrecognizedClientException` | AWS doesn't recognise the credentials. Almost always a stale env-var IAM key overriding the instance role. | Clear `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` from `/home/ubuntu/ea-sys/.env`, re-deploy. |
| `AccessDenied` / `AccessDeniedException` | Credentials *are* recognised, but the identity lacks `ses:SendEmail` (or `ses:SendRawEmail` for attachments). | Update the EC2 instance role policy. |
| `MessageRejected` | SES rejected the message itself, not the credentials. Usually the From address isn't verified, or the account is in sandbox mode and the recipient isn't verified. | Verify the sender domain or recipient in the SES console; for production sending, request sandbox exit. |
| `Throttling` / `Throttled` / `TooManyRequestsException` | SES quota hit. | Check the account's send rate / 24h quota in the SES console; raise via support if legitimate. |
| `InvalidParameterValue` | Malformed payload. Almost always a caller bug (bad email address, oversized attachment). | Check the EmailLog row → caller → fix at the call site. |

---

## Step 1 — Confirm what identity SES is actually being called as

Since the May 31 diagnostic upgrade, every process logs the resolved
credential identity at first SES use. **Find it in `/logs`:**

```
?source=database&search=ses:identity-diagnostic
```

The log line will show:

```json
{
  "msg": "ses:identity-diagnostic",
  "region": "ap-south-1",
  "keyPrefix": "ASIA",
  "hasSessionToken": true,
  "credentialSource": "temporary credentials (instance role / STS / SSO)",
  "envKeySet": false
}
```

**Reading it:**

- `keyPrefix: "ASIA"` + `hasSessionToken: true` → instance role is being
  used. **This is what we want on EC2.**
- `keyPrefix: "AKIA"` + `hasSessionToken: false` → long-term IAM user
  key, from `AWS_ACCESS_KEY_ID` env var or `~/.aws/credentials`. **Bad
  on EC2 if the instance role was intended.**
- `envKeySet: true` + `hasSessionToken: false` → the precedence trap.
  Look for a sibling `ses:env-credentials-in-use` warn log line — it
  fires automatically on this combination.

---

## Step 2 — Quick verification on the box

If `/logs` isn't enough or the diagnostic line is missing (older
deploy), SSH to the EC2 box and run:

```bash
# What's in the container env?
docker compose exec ea-sys sh -lc 'env | grep -E "^AWS_" || echo "(no AWS_* env vars — instance role path)"'

# What identity does the host see (host = EC2 instance, no creds passed)?
aws sts get-caller-identity --region ap-south-1

# What does the container see?
docker compose exec ea-sys sh -lc 'aws sts get-caller-identity --region ap-south-1' 2>/dev/null \
  || echo "(aws-cli not in container — use the host check above)"
```

The two outputs **must match** if you intend to use the instance role.

---

## Retiring an env credential (planned, not an incident)

> Done once, on **2026-08-12**. Written down because the ORDER is the whole
> lesson and the next person will meet the same trap.

Step 3A below tells you to delete the two env keys when they are *stale and
breaking sending*. Doing the same thing **deliberately**, while everything
works, is a different job: the env key may be silently propping up permissions
the instance role never had, and you find that out by breaking them.

That is exactly what happened here. The key belonged to the IAM **user**
`krishna@meetingmindsdubai.com`, which holds `AdministratorAccess`, so it
covered everything. The instance role had SES *send* but not `ses:GetAccount`,
`cloudwatch:DescribeAlarms` or `cloudwatch:GetMetricData`: the three reads
behind the Infra/Ops SES, Alarms and Metrics cards, documented in
`docs/INFRA_OPS.md` and never actually attached. Removing the key first would
have kept email working and quietly blinded the health dashboard and the daily
digest.

**The order: grant, verify, remove, verify, revoke.**

```bash
# 1. FROM YOUR MAC (the box has no IAM write permission, deliberately).
cat > /tmp/EaSysInfraRead.json <<'JSON'
{ "Version": "2012-10-17", "Statement": [{
    "Sid": "EaSysInfraRead", "Effect": "Allow",
    "Action": ["ses:GetAccount","cloudwatch:DescribeAlarms","cloudwatch:GetMetricData"],
    "Resource": "*" }] }
JSON
aws iam put-role-policy --role-name ea-sys-mumbai-ec2-role \
  --policy-name EaSysInfraRead --policy-document file:///tmp/EaSysInfraRead.json

# 2. ON THE BOX: prove the role can do the job BEFORE removing the fallback.
#    `env -u` strips the two vars for this one command, so the CLI drops to the
#    instance role: the exact credential path the app will use afterwards.

#    2a. Confirm you are actually ON the role and not a ~/.aws/credentials file,
#        which would take precedence and make the next test prove nothing.
env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY \
  aws sts get-caller-identity --query Arn --output text
#    → must read assumed-role/ea-sys-mumbai-ec2-role/i-...

#    2b. Send a REAL email through the configuration set. Do not settle for
#        `iam simulate-principal-policy` here: it reported implicitDeny for
#        ses:SendEmail on the config-set ARN while allowing SendRawEmail from
#        the same statement, which is a gap in the simulator's resource-type
#        model, not in the policy. A MessageId settles it in five seconds.
env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY \
  aws sesv2 send-email --region ap-south-1 \
  --from-email-address alerts@meetingmindsexperts.com \
  --destination ToAddresses=<you@yourdomain> \
  --configuration-set-name my-first-configuration-set \
  --content '{"Simple":{"Subject":{"Data":"instance-role SES test"},"Body":{"Text":{"Data":"via the role"}}}}'
```

```bash
# 3. FROM YOUR MAC: containers sit one network hop further from the metadata
#    service than your shell does. IMDSv2 defaults to a hop limit of 1, which
#    blocks them entirely. Ours is 2; check before assuming.
aws ec2 describe-instances --instance-ids i-0b51ab1213d084640 --region ap-south-1 \
  --query 'Reservations[].Instances[].MetadataOptions.HttpPutResponseHopLimit'
```

```bash
# 4. ON THE BOX: now remove BOTH lines. Commenting out only the key id would
#    have worked by accident (the SDK needs both) but leaves an orphan secret.
sudo nano /home/ubuntu/ea-sys/.env       # comment out AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY
sudo bash scripts/deploy.sh              # docker compose restart does NOT re-read env_file
```

**5. Verify, in this order:** an email actually sends; `/admin/infra` SES,
Alarms and Metrics cards are healthy (those three were the ones riding on the
key); `ses:env-credentials-in-use` stops appearing in `/logs`; and the next
morning's daily digest still carries its SES and alarms sections rather than
reporting them unchecked.

**6. Only then revoke the key**: *deactivate*, do not delete, so a forgotten
consumer is one click from recovery. Note it is probably also what your local
`aws` CLI uses.

Rollback at any point is uncommenting the two lines and re-running
`deploy.sh`, about 30 seconds.

---

## Step 3 — Remediation by symptom

### A) `UnrecognizedClientException` + `envKeySet: true` in the diagnostic

The most common failure. Stale long-term keys in `/home/ubuntu/ea-sys/.env`
are overriding the instance role.

```bash
# On the EC2 box:
cd /home/ubuntu/ea-sys
sudo nano .env
# Remove the two lines:
#   AWS_ACCESS_KEY_ID=...
#   AWS_SECRET_ACCESS_KEY=...
# (Optional: keep AWS_REGION and AWS_SES_REGION — those are not secrets.)
sudo bash scripts/deploy.sh
```

The deploy script restarts the container, which picks up the new env.
After restart, `/logs?search=ses:identity-diagnostic` should show
`keyPrefix: "ASIA"` + `hasSessionToken: true`.

### B) Diagnostic shows `keyPrefix: "ASIA"` (instance role) but still `UnrecognizedClientException`

The role itself is broken. Either:

- The role was detached or deleted in AWS.
- The role's trust policy doesn't allow `ec2.amazonaws.com` to assume it.
- The role hasn't propagated yet (just attached — wait 30s, retry).

Check in the AWS console: **EC2 → Instances → the EA-SYS box →
Actions → Security → Modify IAM role**. The role should be present and
non-zero. If missing, attach `ea-sys-app-role` (or whatever it's named
in our IaC).

### C) `AccessDenied` on `SendEmail`

The identity is recognised but the policy is wrong. The role needs at
minimum:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["ses:SendEmail", "ses:SendRawEmail"],
      "Resource": "*",
      "Condition": {
        "StringEquals": {
          "ses:FromAddress": [
            "krishna@meetingmindsdubai.com",
            "noreply@meetingmindsexperts.com"
          ]
        }
      }
    }
  ]
}
```

**Both `ses:SendEmail` AND `ses:SendRawEmail` are required** — the SDK
falls back to `SendRawEmail` whenever attachments are present (badge
PDFs, quote PDFs, inline barcodes), and missing it will cause attachment
emails to fail while plain-text emails succeed. Confusing symptom.

### D) `MessageRejected` — Email address is not verified

The account is still in SES sandbox mode. Either verify each test
recipient in the SES console (slow, per-recipient) or request production
sending mode (15-min approval, lifts the recipient restriction):

AWS Console → SES → Account dashboard → **Request production access**.

The sender domain `meetingmindsexperts.com` is already verified at the
domain level (DKIM + SPF set up via the May 21 cutover). Recipient
restrictions are the only sandbox limitation that bites us.

---

## Step 4 — Verify a fix landed

After remediation, re-trigger a send and verify both the log line and
the `EmailLog` row:

```bash
# From the dashboard, send a test email — easiest path is:
# /events/[any-event]/communications → "Send Now" with one self-recipient.

# Then in /logs:
?source=database&level=info&search=Email%20sent%20successfully
# should show a fresh entry within ~5 seconds.

# And in EmailLog (via /logs DB query or Supabase SQL):
SELECT "createdAt", status, "to", subject, "errorMessage"
FROM "EmailLog"
WHERE "createdAt" > now() - interval '5 minutes'
ORDER BY "createdAt" DESC;
```

Success row = `status: "SENT"` + non-null `providerMessageId`. Failure
row carries the AWS error name + requestId in `errorMessage` (post-May
31 deploy).

---

## What NOT to do

- **Do NOT** retry on `UnrecognizedClientException` in code. It's
  non-transient — retrying with the same bad credentials sends the same
  rejection. The current `sendEmail` does not retry, and that's
  correct.
- **Do NOT** pin the credential provider chain to `fromInstanceMetadata`
  only in code. That works on EC2 but breaks local dev where
  `~/.aws/credentials` is the right source. The clean fix is to clear
  the stale env on the box, not to hard-code provider order.
- **Do NOT** log the full `accessKeyId` / `secretAccessKey`. The
  diagnostic logs the first 4 chars only (the public key class prefix
  — AKIA / ASIA / etc — is safe to log per AWS guidance).

---

## Related

- [src/lib/email.ts](../src/lib/email.ts) — provider implementation +
  identity diagnostic + AWS error capture
- [docs/HANDOVER.md](HANDOVER.md) — operator handover including
  credential rotation procedure
- Sentry issue 121795612 — the May 22 occurrence that motivated this
  runbook + the diagnostic upgrade
