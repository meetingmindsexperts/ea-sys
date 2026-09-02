# Compliance readiness note: Q4 revisit

**Prepared by:** Krishna, Development Manager
**Date:** 2 September 2026
**Purpose:** Agreed summary ahead of the Q4 compliance revisit. One page: where we stand, what closed recently, what remains, and the decisions that need Medhat.
**Source of truth:** [SECURITY_AND_PRIVACY_POSTURE.md](SECURITY_AND_PRIVACY_POSTURE.md), verified against the running production system 19–24 August 2026.

---

## 1. Where we stand

EA-SYS has a full, honest security and privacy posture document, originally built for the Emirates Health Services vendor assessment and verified against the live system in August. The engineering controls are strong: role-based access with nine roles enforced server-side, encryption at rest and in transit on every path carrying personal data, a complete audit trail, automated retention and deletion, geographically separated hourly backups with quarterly restore drills, and a rollback drilled at roughly 20 seconds.

What we lack is not controls but **attestation and paperwork**: no certification, no independent penetration test, no published privacy policy, and two policy-level gaps (MFA, data residency) that need a business decision rather than engineering.

## 2. Closed since August

| Item | Status |
|---|---|
| Server disk encryption (last "no" on encryption at rest) | Done 21 Aug, in a planned 8-minute window |
| Account-wide default EBS encryption (the setting an assessor checks) | Done 20 Aug |
| Database backups moved to hourly, worst-case loss under 1 hour | Live since end of July |
| Sensitive-document serving flipped to an allow-list (private by default) | Done 19 Aug |
| Session revocation (a compromised account can now be signed out) | Web done 11 Aug, mobile 25 Aug |
| Visitor analytics kept in-house: no Google Analytics, no cookies, no IP retained | Live 20 Aug |

## 3. Remaining engineering items (cheap: configuration or days of work)

None of these need budget or a decision; they are scheduled inside the agreed Monday/Wednesday/Thursday maintenance windows.

1. **Require TLS on the database connection.** One configuration value plus a redeploy. Traffic is already encrypted in practice; this makes it enforced, which is the answer that survives an audit.
2. **Delete the retained unencrypted disk and snapshots** from the encryption work. They were kept as the rollback; the bake period ended 28 August, so deletion is now due. Until then, encryption at rest is true of the live system but not of every historical copy.
3. **Move uploaded documents to encrypted object storage.** Code is written, tested and deployed; what remains is creating the bucket and one setting. This is the item that specifically covers passport scans and bank details, none of which have been collected yet, so the control lands before the first sensitive document does.
4. **Settle the live-stream position** (self-hosted streaming is unencrypted; it has never carried a real audience). Either enable the encrypted variant or leave it off until needed.
5. **Automate dependency vulnerability scanning** (currently run manually before releases).
6. **Update the posture document itself:** (a) the HR module now holds staff sick-leave records, which is health-adjacent personal data, while the document describes the database as event data; (b) remove the stale "no session revocation" gap, which has been fixed since August.

## 4. Remaining documentation items (no engineering)

- Privacy policy and data-processing agreement template (likely to be requested by any client assessment).
- Breach-notification procedure. UAE PDPL requires notification; our process is not written down.
- Data-subject-request procedure with a response-time commitment.
- A defined maximum retention period for uploaded documents.

## 5. Decisions needed at the Q4 revisit

| # | Decision | Context |
|---|---|---|
| 1 | **Multi-factor authentication** for staff accounts | The most common hard requirement in public-sector questionnaires. An engineering task; needs prioritisation against feature work. |
| 2 | **Independent penetration test, and whether to pursue certification** (ISO 27001 / SOC 2) | We have practices and documentation, not attestation. A pen test is a bounded purchase and the usual first step; certification is a programme. Budget decision. |
| 3 | **Data residency position** | No data is in the UAE. The AWS UAE region is currently non-operational (AWS's own notice, multi-month recovery), Bahrain is a different country, and our database provider has no Middle East region at all. We are prepared: once the region recovers, moving uploaded documents in-country is a configuration change. Full residency would mean changing providers. Recommend deciding only when a client actually requires it. |
| 4 | **Data Protection Officer** | None appointed. Decide whether one is needed at current scale or deferred. |

## 6. Suggested sequence for Q4

Cheapest first: items 3.1 to 3.6 above (all configuration or days), then the documentation set in §4, then MFA, then the pen-test decision. Residency stays a client-driven decision, not a default project.
