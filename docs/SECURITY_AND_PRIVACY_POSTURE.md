# Security & privacy posture — client questionnaire responses

**Status:** working answers, verified against the running system on 2026-08-19.
**Trigger:** Emirates Health Services vendor assessment.
**Audience:** MM Group, for completing client security questionnaires.

> ⚠️ **Read this before sending anything.** Several answers below are "no" or
> "partially". They are written honestly on purpose. Overstating a control to a
> government health authority is worse than disclosing a gap with a remediation
> date, because the first is discoverable later and destroys the relationship,
> while the second is an ordinary procurement conversation.
>
> **§0 lists the four answers most likely to fail their review.** Decide how to
> handle those before responding, not after.

---

## 0. The answers that need a decision first

| # | Issue | Why it matters to EHS specifically |
|---|---|---|
| **0.1** | **No data is stored in the UAE, and in-UAE hosting on AWS is not currently available to anyone.** Primary database and application are in **AWS Mumbai (ap-south-1)**; disaster recovery in **Singapore**; the marketing contact mirror is in the **EU**; AI, payments and video are **US** services. **As of 2026-08-19 the AWS UAE region (`me-central-1`) is not operational** — see the box below. | EHS is a UAE federal health authority. Public-sector and health-sector procurement frequently mandates in-country storage. This remains the most likely blocker, but the answer is now materially stronger: it is a regional constraint, not an architectural choice. |
| **0.2** | ✅ **CLOSED 2026-08-21 — the server's disk is now encrypted at rest.** The EC2 root volume was replaced with an encrypted one (`vol-08f22cd184c2bf880`, 50 GB, AES-256, AWS-managed KMS key) in a planned 7-minute window — [MAINTENANCE_LOG.md](MAINTENANCE_LOG.md) MAINT-001. Uploaded files live on that volume, so this covers them. **Remaining caveat, stated because it is the honest answer:** the previous unencrypted volume and four unencrypted snapshots of it are deliberately retained as the rollback until roughly 2026-08-28, and each is a full plaintext copy. Until they are deleted the control is in force on the live system but not yet on every historical copy. | "Encryption at rest" is a standard yes/no on these forms. The answer for uploaded files is now **yes** — as it already was for the database and the DR backups (§3). |
| **0.3** | **No multi-factor authentication.** Accounts are email + password only. | Common hard requirement for systems holding personal data in the public sector. |
| **0.4** | **No independent certification or penetration test.** No ISO 27001, no SOC 2, no third-party pen test. | Many questionnaires ask for a certificate number. We have practices and documentation, not attestation. |

Everything below is accurate as it stands.

> ### The AWS UAE region is not operational (2026-08-19)
>
> On attempting to provision storage there, the AWS console returned:
>
> > *"The Middle East (UAE) (ME-CENTRAL-1) Region has suffered damage as a
> > result of the conflict in the Middle East and is currently unable to
> > reliably support customer applications. While some workloads continue to
> > function normally, we strongly recommend customers migrate all accessible
> > resources to other Regions and restore inaccessible resources from remote
> > backups as soon as possible. Relevant billing operations are currently
> > suspended while we restore normal operations in this AWS Region. This
> > process is expected to take several months."*
>
> **This changes the residency answer from a weakness into a verifiable fact
> about the region.** In-country hosting on AWS is not purchasable by any vendor
> right now, and AWS is advising customers already there to leave. If EHS
> requires UAE residency, that is a conversation about timing, or about a
> non-AWS provider (Azure UAE North, Oracle Dubai), not about our architecture.
>
> **Do not offer a migration to `me-central-1` in any response.** We attempted
> it, declined on the basis of this notice, and the work is staged to resume
> when the region recovers.

---

## 1. Data storage location

**Answer: data is not stored in the UAE.** Locations, by system:

| What | Where | Provider |
|---|---|---|
| Application server (web + background worker) | **Mumbai, India** (`ap-south-1`) | AWS EC2 |
| Primary database (all registration, speaker, session, financial data) | **Mumbai, India** | Supabase (managed PostgreSQL on AWS) |
| Uploaded files (photos, badges, documents, certificates) | **Mumbai, India** — on the application server's own disk | AWS EBS |
| Database backups + file copies (disaster recovery) | **Singapore** (`ap-southeast-1`) | AWS S3 |
| Application logs | **Mumbai** | AWS CloudWatch |
| Transactional email | **Mumbai** | AWS SES |
| Marketing contact mirror | **EU (Stockholm, `eu-north-1`)** | Supabase |
| Payments | **United States / global** | Stripe |
| Video / webinars | **United States / global** | Zoom |
| AI assistant features | **United States** | Anthropic |
| Error tracking | **United States / EU** | Sentry |

**Cross-border transfers to disclose explicitly:**

- **Singapore** — hourly database dumps and an hourly copy of all uploaded files, for disaster recovery. Encrypted, private, 30-day retention on database dumps.
- **EU** — a copy of the organisation-wide *contact* record (name, email, phone, employer, job title, city, country, specialty, event names attended) is mirrored to a marketing database. This is an internal MM Group system, not a third party, but it is a genuine cross-border transfer of attendee personal data and should be declared.
- **United States** — payment data (Stripe), webinar participation (Zoom), and any text sent to the optional AI assistant features.

**If EHS requires UAE residency**, the position as of 2026-08-19:

- **AWS UAE (`me-central-1`) is not an option today.** AWS has declared it unable to reliably support customer applications and is advising customers to migrate out, with a multi-month recovery estimate (see §0). We attempted to provision there and declined on that basis.
- **AWS Bahrain (`me-south-1`) does not satisfy UAE residency** — it is a different country. It would also sit roughly 500km away in the same theatre as whatever damaged the UAE region, so it buys a weaker claim alongside correlated risk.
- **The database cannot move to the Middle East at all.** Our managed PostgreSQL provider (Supabase) offers 16 regions and none is in the Middle East, so in-country hosting of registration data would additionally mean replacing the database platform.
- **What is prepared:** the application's file storage has been rebuilt so that the storage location is a configuration value rather than a code change. Moving uploaded documents into a UAE bucket, once the region is healthy, is a bucket and two settings rather than a migration project.
- **A non-AWS UAE provider** (Azure UAE North, Oracle Dubai) is technically possible and would be a scoped project.

---

## 2. Types of personal data collected

**Attendees / delegates:** title, first and last name, email (plus optional second email), mobile and work phone, organisation, job title, professional role, medical specialty, city, state, postal code, country, photograph, dietary requirements, membership number, student ID and its expiry date, registration type, free-text notes, tags.

**Speakers and faculty:** all of the above, plus biography, website and social links, presentation and session assignments, and — where the module is used — **passport number, a scan of the passport, and full bank account details** (bank name, address, country, account number, IBAN, SWIFT) for expense reimbursement.

**Abstract authors:** submission title and full text, co-author names and affiliations, review scores and reviewer comments.

**Financial:** invoices, credit notes, payment records, card brand and last four digits, Stripe payment identifiers, billing address and tax number. **Full card numbers are never stored or transmitted through our systems** — payment is handled entirely by Stripe's hosted checkout.

**Operational:** entry barcode, DTCM compliance barcode (Dubai events), check-in timestamps, badge type, accommodation and room assignment, survey responses, certificates issued.

**Account and security:** password (stored only as a bcrypt hash), sign-in timestamps, **IP address**, browser user-agent, and an approximate city/country derived from the IP address. Every administrative action is recorded with the acting user and their IP.

**Verified state of the sensitive document store, 2026-08-19.** The capability to
collect passports, identity documents, CVs and bank details exists and is
described above, but **no such document has ever been uploaded.** Checked
directly on the production server: the storage directories for speaker
documents, reimbursement documents and registration supporting documents **do
not exist**, because nothing has ever been written to them. What is on disk is
404 photographs, 38 issued certificates, 66 media-library images, 4 agreement
letterheads, 1 CRM document and 2 payment receipts.

This matters for two reasons. It is the accurate answer to "do you hold
passports today", which is **no**. And it means the controls described in §4 and
the encryption work in §3 are being put in place *before* the first sensitive
document arrives rather than after, which is the defensible order.

**If passports are to be collected for this event, they should be collected
through the speaker document form rather than by email**, so that they land
under the access controls, audit trail and retention rules described here
instead of in a mailbox.

**Special-category considerations to flag proactively:**
- **Dietary requirements** can disclose religion or a medical condition.
- **Passport scans and bank details** would be the most sensitive items in the system, once collected.
- **Health-professional specialty** is occupational rather than health data about the individual, but reviewers sometimes treat it as sensitive.

---

## 3. Encryption

**In transit — yes, throughout.**
- All web and API traffic over HTTPS/TLS, certificates issued and auto-renewed via Let's Encrypt.
- Database connections require SSL.
- All third-party integrations (Stripe, Zoom, SES, Supabase, Anthropic) over TLS.

**At rest — partially. This is the honest position:**

| Data | Encrypted at rest | Detail |
|---|---|---|
| Primary database | **Yes** | Supabase encrypts storage at rest (AES-256) |
| Disaster-recovery backups (Singapore) | **Yes** | S3 server-side encryption with a **customer-managed KMS key**; bucket has all four public-access blocks enabled; verified 2026-08-18 |
| **Uploaded files on the server** | **Yes** (since 2026-08-21) | EC2 root volume encrypted with AES-256, AWS-managed KMS key — see §0.2 and MAINT-001. Retained unencrypted snapshots are the one open caveat, deleted after the rollback bake period |
| Passwords | **Yes, one-way** | bcrypt, cost factor 10 — never recoverable, not merely encrypted |
| API keys and access tokens | **Yes, one-way** | SHA-256 hashed; the plaintext is shown once at creation and never stored |
| Stored third-party credentials (Zoom, Stripe, EventsAir, AI keys) | **Yes** | AES-256-GCM application-level encryption, key derived from the application secret |
| Single-use links (surveys, agreements, reimbursement forms) | **Yes, one-way** | SHA-256 hashed with a server-side pepper |

**Remediating §0.2 — there are now two routes, and they are independent:**

1. ✅ **DONE 2026-08-21. Encrypt the EBS volume.** AWS cannot encrypt a volume in place: it requires a snapshot, a new volume and a swap, so the instance must be stopped. **It took 7 minutes 45 seconds, not the 30 to 60 estimated here** — because enabling default EBS encryption first (step 0 below) removes the separate encrypted-copy pass, and a warm-up snapshot taken while the server was still running moved the bulk of the copying out of the downtime window entirely. The public IP survives (an Elastic IP is attached) and the original volume is retained, so rollback is reattaching it. **Independently, enabling default EBS encryption on the account is free, instant and zero-downtime** — it does not touch the running volume, but every future volume and snapshot is encrypted, and it is the account setting an assessor checks.
2. **Move uploaded files off the volume into S3** with a customer-managed KMS key. As of 2026-08-19 the application code for this is written, tested and deployed, sitting behind a single configuration value; what remains is creating the bucket. This also adds object versioning (a deleted document becomes recoverable, which it is not today) and removes the single-volume dependency for the one class of data that cannot be regenerated.

Route 2 addresses the specific concern — passport scans and bank documents — and is lower risk because it needs no downtime. Route 1 addresses the whole disk. **Doing both is the complete answer**, and neither blocks the other.

---

## 4. User access controls and administrative privileges

**Role-based access control with nine roles**, each with a deliberately different scope:

| Role | Scope |
|---|---|
| Super Admin | Full access, plus system administration |
| Admin | Full access to the organisation's events |
| Organizer | Full access to assigned events |
| Member | Read-only across the organisation, plus registration-desk actions |
| Onsite Staff | **Per-event assignment only** — registration desk, check-in, badge printing |
| Webinars | Full control of webinar events; registration desk elsewhere |
| CRM User | Confined to the sponsorship pipeline; no access to events |
| Reviewer | Abstract review only, for assigned events |
| Submitter / Registrant | Their own submissions or registration only |

**Enforcement is layered, not cosmetic:** every write endpoint runs a server-side role guard, every event query is scoped by role and per-event assignment, page routing redirects unauthorised roles, and the interface hides what the role cannot do. Access is denied by default — an unrecognised role gets the narrowest permission set, not the widest.

**Field-level visibility** is separately controlled. Nine distinct rules govern who can see financial amounts, entry barcodes, contact records, sign-in activity and supporting documents. They deliberately disagree with each other: a read-only Member can see payment amounts but not entry barcodes (a barcode is a physical door credential); temporary onsite staff can see barcodes but not the contact database.

**Additional controls:** temporary onsite accounts are assigned to specific events and see nothing else; passport and bank documents are excluded from every role except Admin and Organizer and are never served from a public URL; API keys are organisation-scoped, hashed, expirable and revocable; external integrations use OAuth 2.1 with mandatory PKCE, and an administrator must approve each connection on a consent screen that displays the destination.

**Strengthened 2026-08-19.** The rule that keeps sensitive documents off the public web was previously a list of the categories to refuse. That fails in the unsafe direction: a category added later is served publicly until someone remembers to update that list. It is now the inverse — an explicit list of the categories that *may* be served, with everything else refused — so a new document type is private by default and the failure mode is a broken image rather than an exposed passport. In the same change, every file read and write in the application was routed through a single component that enforces the path checks centrally, replacing a dozen separate copies of the same logic.

**Gaps to declare:**
- **No multi-factor authentication.**
- **No session revocation.** Sessions are stateless tokens valid for 48 hours; a compromised account cannot be forcibly signed out before expiry, and a password change does not invalidate an existing session.
- **No IP allow-listing** for administrative access.

---

## 5. Data retention and deletion

**Automated retention, enforced by scheduled jobs:**

| Data | Retention | Mechanism |
|---|---|---|
| System logs | 30 days | Daily prune job |
| Sent-email content | 180 days (the record of the send is kept; the message body is erased) | Daily prune job |
| Sign-in history | 180 days, then fully deleted | Daily prune job |
| Database backups (Singapore) | 30 days | S3 lifecycle rule |
| Unclaimed uploaded documents | Nightly cleanup of files never attached to a registration | Nightly prune job |
| Historical log archive | Compressed and retained | Monthly archive job |

**Deletion on request.** Registrations, speakers, contacts and their uploaded files can be deleted by an administrator through the interface. Deletion removes the record and its attached documents, and shared files are only removed once no other record references them.

**Gaps to declare:**
- **The audit trail is never deleted.** Administrative-action records — including the acting user and their IP address — are retained indefinitely by design, so that the audit history cannot be edited. This means a deletion request does not remove every trace of a person. This is a common and defensible position, but it must be disclosed rather than discovered.
- **Uploaded files have no maximum age.** Photographs, passport scans and certificates persist until deleted manually.
- **No documented data-subject-request procedure** with a response-time commitment. The capability exists; the written process does not.

---

## 6. Third-party integrations

| Service | Purpose | Personal data shared | Location |
|---|---|---|---|
| **Stripe** | Card payments | Name, email, amount, billing address. Card details go directly to Stripe and never reach our servers | US / global |
| **AWS SES** | Sending email | Recipient name, email, message content | Mumbai |
| **Supabase** | Database hosting | All application data | Mumbai (primary), EU (marketing mirror) |
| **AWS S3 + KMS** | Backups | All application data, encrypted | Singapore |
| **AWS CloudWatch** | Log storage | Application logs | Mumbai |
| **Zoom** | Webinars | Name, email, attendance and participation records | US / global |
| **Anthropic** | Optional AI assistant and help features | Only what a staff member types into the assistant, plus event context | US |
| **Sentry** | Error tracking | Technical error details; may incidentally include identifiers | US / EU |
| **EventsAir** | One-directional import from the previous platform | Read-only import of contact data | Vendor-hosted |
| **ipapi.co** | Approximate location of a sign-in | IP address only. Can be disabled with one setting | US |
| **MediaMTX** | Live video streaming | Self-hosted on our own server; no third party involved | Mumbai |
| **Visitor analytics** | Counting visits to public event pages | Self-hosted, our own software; no cookie, no IP retained, no third party involved | Mumbai |

**No advertising or third-party analytics.** There is no Google Analytics, no advertising pixel, no tracking cookie, and no third-party analytics of any kind. The only cookie is the sign-in session.

**We do count visits to public event pages, using our own software.** This was added on 2026-08-20 and the distinction from the paragraph above is deliberate rather than a hedge:

- **Nothing is stored on the visitor's device.** No cookie, no localStorage, no sessionStorage. This is stricter than the law requires and is why no consent banner is needed.
- **No IP address is retained.** There is no column for one. The address is used at the moment of the request to derive an anonymous identifier and is then discarded.
- **That identifier cannot be followed across days.** It is an HMAC under a salt derived from the date, so it changes every 24 hours by construction. See the appendix below; it is nine lines and a reviewer can verify the property by reading them.
- **Nothing leaves our infrastructure.** The data lands in the same Mumbai database as everything else and is encrypted at rest with it (§3). No third party receives it, and no vendor assessment applies.
- **A visitor cannot be identified.** We can answer "500 people opened the registration page and 80 registered". We cannot answer "did Dr X visit", and the design makes that permanently impossible rather than merely disallowed.

Retained for 400 days, then deleted, so a year-on-year comparison is possible and nothing accumulates indefinitely.

### Appendix: how a visitor is counted without being identified

The whole mechanism, so it can be checked rather than taken on trust:

```
salt        = HMAC-SHA256(secret, "YYYY-MM-DD")        # changes every day
visitorHash = HMAC-SHA256(salt, siteId + ip + userAgent)
```

The date is an *input*, so rotation cannot fail to happen: there is no scheduled job that could stop, and yesterday's identifier is unreachable today. `siteId` is included so the same person visiting two customers' events produces two unrelated identifiers, which is what prevents any correlation between customers. The IP and user agent are consumed here and never stored. Source: `src/analytics/core/visitor-hash.ts`.

**Fonts** are served from Google Fonts, which discloses visitor IP addresses to Google. Trivial to self-host if EHS objects.

---

## 7. Compliance with privacy and cybersecurity requirements

**Applicable regime:** UAE Federal Decree-Law No. 45 of 2021 (PDPL), plus DTCM event-compliance requirements for Dubai events, which the system supports directly through compliance barcodes.

**What we have:**
- Personal data is collected for a stated purpose (event registration and delivery), with terms and conditions presented and acceptance recorded with a timestamp.
- Role-based access control and field-level visibility rules, enforced server-side and covered by an automated test suite of over 5,500 tests.
- A complete audit trail of administrative actions, including bulk data exports and imports, recording who acted, when, and from which IP address.
- Automated retention and deletion for logs, email content and sign-in history.
- Encrypted, geographically separated backups with documented recovery procedures and a quarterly restore drill.
- Written incident history with post-mortems.
- Cross-border transfers documented (§1) and, in the case of the EU marketing mirror, explicitly signed off internally.

**What we do not have, stated plainly:**
- **No ISO 27001, SOC 2, or equivalent certification.**
- **No independent penetration test.**
- **No formally published privacy policy or data-processing agreement template.** This is straightforward to produce and is likely to be requested.
- **No appointed Data Protection Officer.**
- **No data-residency guarantee**, and currently no UAE storage (§0.1).

---

## 8. Vulnerability management and incident response

**Preventive:**
- Every change passes automated type checking, linting, a 5,500-test suite and a production build before it can deploy. Additional automated gates block known dangerous patterns, including unsafe database migrations and missing authorisation checks.
- Rate limiting at the web-server layer per IP address, plus per-endpoint limits in the application on every sensitive operation (sign-in, registration, payment, exports, bulk email).
- Automated banning of IP addresses that repeatedly trigger rate limits.
- Brute-force protection on sign-in: per-account and per-IP throttling that counts only failures and resets on success.
- File uploads validated by inspecting file contents, not the declared type; size limits enforced; sensitive documents stored outside any publicly reachable path and served only through an authenticated endpoint that binds the file to a record the requester is permitted to see. The public/private split is an allow-list, so an unclassified document category is private by default (§4).
- Standard protections against injection (parameterised database queries throughout), cross-site scripting (output escaping), and cross-site request forgery (same-origin checks on credential-issuing endpoints).

**Detection:**
- Real-time error alerting by email on every application error, with deduplication.
- Six infrastructure alarms (CPU, memory, disk, credit balance, instance health) alerting to the operations team.
- A daily infrastructure health email, sent whether or not anything is wrong, so that silence is not mistaken for health.
- Centralised logging with 30-day (application) and 90-day (error) retention, searchable through an administrative interface.
- A watchdog that detects and restarts a frozen background worker, and alerts on every restart.

**Response and recovery:**
- Documented incident procedures, including a specific DDoS response plan and a ransomware response plan.
- A written incident log with post-mortems for previous production incidents, used to drive preventive changes.
- Database backups hourly to a separate geographic region; uploaded files copied hourly; recovery procedures documented and drilled quarterly.
- Rollback to any previous release in approximately 20 seconds, drilled and timed.
- A standby environment in Singapore for regional failure.

**Gaps to declare:**
- **Dependency vulnerability scanning is manual**, run before releases rather than automatically on a schedule. Easily automated.
- **No web application firewall.** Protection is rate limiting and IP banning at the web-server layer.
- **No formal severity classification or response-time commitment.** Incidents are handled promptly by a small team, but there is no published SLA.
- **No external breach-notification procedure** with a defined timeline. PDPL requires notification; the process is not written down.

---

## 9. Suggested remediation order

If EHS asks what will change and by when, this is a defensible sequence. Items 1 to 4 are days of work; item 5 is a project.

0. **Enable default EBS encryption on the account** (§3). Free, instant, no downtime. Does not fix the existing volume, but every future volume is encrypted and it is the account setting an assessor checks. Do this today.
1. **Move uploaded documents to encrypted object storage** (§3, route 2). The code is already written, tested and deployed; what remains is creating the bucket and changing a setting. No downtime. This is the route that specifically covers passport scans and bank details, and it adds recoverability of a deleted document.
2. ✅ **DONE 2026-08-21. Encrypt the server disk** (§0.2, route 1). Removes the last "no" on encryption at rest. Took **7 minutes 45 seconds** of planned downtime; see MAINT-001 for the method that made it that short.
3. **Enable multi-factor authentication** for administrative accounts (§0.3).
4. **Write the privacy policy, data-processing agreement and breach-notification procedure** (§7, §8). Documentation only, no engineering.
5. **Automate dependency scanning** and publish a response-time commitment (§8).
6. **Data residency** (§0.1). Only if EHS requires it, and **not to AWS UAE**, which is not operational. Options are a non-AWS UAE provider, or waiting for the region to recover, at which point moving uploaded documents is a configuration change rather than a project.

Independently worth doing: a defined retention period for uploaded documents, and a written data-subject-request procedure (§5).

**Note on ordering.** Items 0 to 2 all address the same finding by different means and are listed cheapest-first. Item 0 costs nothing and should not wait for a decision about the others.
