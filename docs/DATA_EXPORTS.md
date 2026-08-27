# Data exports: who can download what

> **Read this before adding anything that emits a file.** Last verified against
> the code on **2026-08-27** by resolving every guard to its role set, not by
> reading comments. If you change an export's guard, change the table here in
> the same commit — a permissions table nobody updates is worse than no table,
> because it gets quoted.

---

## 1. The one-line answer

**Full data exports are Admin-and-above work.** Organizers can export their own
events. Onsite desk staff can export the registrations list (they run the door).
Everyone else is either narrower or excluded, with two known gaps in §6.

---

## 2. The matrix

"Who" is the resolved role set, not the guard's name.

| What comes out | Guard | Who can | Audited | Rate limit |
|---|---|---|---|---|
| **Registrations CSV** | `canExportRegistrations` | SUPER_ADMIN · ADMIN · ORGANIZER · ONSITE · WEBINARS · API keys | ✅ | 10/hr |
| **Contacts CSV** (org address book, incl. private notes) | `canExportContacts` | SUPER_ADMIN · ADMIN · ORGANIZER · MEMBER | ✅ | 10/hr |
| **Org invoice ledger** (csv · QuickBooks · PDF zip) | `denyFinance` + named refusal | SUPER_ADMIN · ADMIN · ORGANIZER · MEMBER · ONSITE | ✅ | — |
| **Event invoices** | `denyFinance` | SUPER_ADMIN · ADMIN · ORGANIZER · MEMBER · ONSITE · WEBINARS | ✅ | — |
| **Reimbursements CSV** — passport numbers, IBANs | `denyReviewer` | SUPER_ADMIN · ADMIN · ORGANIZER | ✅ | — |
| **Travel grants CSV** | `denyReviewer` | SUPER_ADMIN · ADMIN · ORGANIZER | ✅ | — |
| **RSVP roster CSV** | `denyReviewer` | SUPER_ADMIN · ADMIN · ORGANIZER | ✅ | — |
| **Session proposals CSV** | `denyReviewer` | SUPER_ADMIN · ADMIN · ORGANIZER | ✅ | — |
| **Certificate bundle (zip)** | `denyReviewer` | SUPER_ADMIN · ADMIN · ORGANIZER | ✅ | yes |
| **Survey responses CSV** | `denyReviewer` + Webinars | SUPER_ADMIN · ADMIN · ORGANIZER · WEBINARS | ✅ | — |
| **CRM deals / activity CSV** | `requireCrmExport` | **SUPER_ADMIN · ADMIN only** | ✅ | 10/hr |
| **System log archive** | `denyNonOperator` | Platform operator only | — | — |
| ⚠ **Webinar attendance CSV** | org membership + event access **only** | any org-bound role — incl. MEMBER, ONSITE | ✅ | — |
| ⚠ **Analytics CSV + per-attendee check-in log** | event access **only** | anyone linked to the event — **incl. REVIEWER, SUBMITTER, REGISTRANT** | ✅ | — |

Single-record downloads (one invoice PDF, one badge, one uploaded passport) are
**not** in this table. They are covered in §5 and follow different rules.

---

## 3. Why the boundaries disagree, on purpose

Nine `*-visibility.ts` predicates exist and several deliberately do not match.
Reaching for a "close enough" existing one is the signal to write a new one.

- **MEMBER can export contacts but NOT registrations.** MEMBER is internal
  read-only staff. The contacts book is org reference data; the registrations
  file carries entry barcodes, which are a door credential.
- **ONSITE can export registrations but NOT contacts.** The desk needs its own
  event's list. Onsite staff are temps, contractors and vendors, and the org
  address book is not theirs.
- **CRM_USER can read the CRM but cannot export it.** Reading is the job;
  walking out with the pipeline is not.
- **ORGANIZER cannot export the CRM at all**, even though they can export their
  events. Sponsorship money is a different book.
- **WEBINARS is finance-capable but refused the org-wide invoice ledger by
  name.** Being able to take a payment at a desk is not the same as reading
  every invoice the organisation has ever issued.
- **Export is deliberately narrower than read** in three places (registrations,
  contacts, CRM). Seeing a list on screen and walking away with the file are
  different acts, and the second is the one that leaves the building.

---

## 4. What gets recorded

Every export in the table above writes an `AuditLog` row via `recordExport`
([src/lib/audit-data-transfer.ts](../src/lib/audit-data-transfer.ts)):

- **who** (userId, role), **when**, **from where** (IP)
- **how many rows**, in which **format**
- **which filters** narrowed it, so a 12-row targeted pull is distinguishable
  from a whole-book dump

**The free-text search term is deliberately NOT stored.** `AuditLog` has no
prune job and its rows survive a subject-erasure request, so storing what an
operator typed would recreate the PII we delete elsewhere. A length and a
truncated hash are kept instead, which still answers *targeted or full dump?*
and still correlates repeated searches.

Answering *"who exported our attendee list last month?"* is a query against
`AuditLog` filtered on `action = 'EXPORT'`.

---

## 5. Single-record downloads (different rules)

These emit a file for **one** person and are not "exports" in the sense above.

| File | Who |
|---|---|
| One invoice / quote / receipt PDF | `denyFinance`, or the registrant's own |
| Badge PDF | registration desk (`REGISTRATION_DESK_ALLOW`) — audited as `BADGE_PRINTED` |
| Supporting document (resident letter etc.) | `canViewSupportingDocument` — excludes MEMBER **and** ONSITE |
| Reimbursement attachments (passport, bank letter) | `denyReviewer` — Admin/Organizer |
| Speaker documents (passport, CV) | `denyReviewer` — Admin/Organizer |

Uploaded documents live under `/uploads/` prefixes that the public catch-all
**refuses by allow-list**, so they are reachable only through the authenticated
route. See [UAE_DOCUMENT_RESIDENCY_PLAN.md](UAE_DOCUMENT_RESIDENCY_PLAN.md).

---

## 6. Known gaps (open, not yet fixed)

Found 2026-08-27 while building this table. Both are **audited**, so an
after-the-fact answer exists; neither is **prevented**.

1. **Analytics has no role guard at all** — not even an org check. Access is
   event linkage alone, and `buildEventAccessWhere` deliberately grants org-null
   roles the events they are linked to. So a **reviewer, submitter or registrant
   on an event can download `?export=checkins`**: registration number, name,
   email and door timestamp for every attendee.
2. **Webinar attendance CSV** has org membership and event access but no export
   gate, so MEMBER and ONSITE can pull every attendee's name, email and watch
   times.

Both are the same shape as the July 2026 contacts finding: the guard sat on the
**write**, and the read inherited *"you can see this event"* as if it meant
*"you may download everyone on it"*.

**Not currently reachable by a registrant in practice** for #2 — prod has zero
org-bound REGISTRANT accounts. #1 needs no org, only a link to the event.

**Also inconsistent:** the reimbursements CSV is the most sensitive file in the
system and has **no rate limit**, while the registrations list has 10/hr. Travel
grants, RSVP roster, webinar attendance, invoices, survey responses and analytics
are likewise unlimited — their rate limits sit on the POST handlers, not the
export GET.

---

## 7. Adding a new export

1. **Pick the predicate deliberately.** Ask who should walk away with the file,
   not who can already see the screen. If no existing predicate has the right
   shape, write a new one — that is the convention, not a failure.
2. **Gate BEFORE the query.** A refused export should not first run an unbounded
   `findMany` on the box that serves the door scanner.
3. **Call `recordExport`.** Who, how many, which filters.
4. **Escape every cell** with `escapeCsvCell` — a leading `=` in a spreadsheet is
   a formula, not text.
5. **Rate-limit it**, on the GET that emits the file.
6. **Add a row to §2 above**, in the same commit.

---

## 8. Related

- [src/lib/audit-data-transfer.ts](../src/lib/audit-data-transfer.ts) — the recorder
- [src/lib/registration-export-visibility.ts](../src/lib/registration-export-visibility.ts) · [contact-visibility.ts](../src/lib/contact-visibility.ts) · [finance-visibility.ts](../src/lib/finance-visibility.ts)
- [SECURITY_AND_PRIVACY_POSTURE.md](SECURITY_AND_PRIVACY_POSTURE.md) — the client-facing posture
- CLAUDE.md § RBAC — what each role is for
