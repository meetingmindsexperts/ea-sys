# RLS Migration Status

## Release criterion

`RLS_SET_LOCAL=1` may be enabled for a production tenant only after every
in-scope domain is marked **COMPLETE**, every database write path in that domain
uses `tenantTransaction` (or has a documented operator-lane exception), and
every entry point reaches the domain inside `runWithTenant`.

Run `bash scripts/rls-migration-status.sh` for a measurable inventory. Before
the platform-wide switch, run
`bash scripts/rls-migration-status.sh --require-ready`; it fails while any
checklist domain is pending or ordinary `db.$transaction` calls remain.

## Domain checklist

| Domain | Status | Completion evidence | Owner / next action |
| --- | --- | --- | --- |
| Contacts | COMPLETE | Tenant ALS pilot, tenant transactions, real-Postgres coverage | Maintain CI allow-list and integration coverage. |
| Registrations and payments | PENDING | REST, public, MCP, worker, and finance paths all need one audit | Inventory entry points and migrate writes together. |
| Abstracts and peer review | PENDING | Public, dashboard, reviewer, and MCP paths need one audit | Migrate resource-scoped reads and writes. |
| Speakers and sessions | PENDING | Dashboard, public, and MCP paths need one audit | Migrate together because they share event visibility. |
| Accommodation | PENDING | Dashboard and worker paths need one audit | Migrate availability transactions first. |
| Certificates and documents | PENDING | Worker, public delivery, and storage metadata paths need one audit | Verify cross-tenant candidate scans borrow the resource tenant lane. |
| Communications and scheduled email | PENDING | Dashboard, MCP, and scheduled worker paths need one audit | Migrate enqueue and drain paths as a single unit. |
| CRM | PENDING | CRM API, agent, inbound mail, and worker paths need one audit | Preserve deliberate operator-reader exceptions. |
| Webinar | PENDING | Console, public sessions, Zoom callbacks, and workers need one audit | Include role-scoped manage/desk access tests. |
| Analytics and operations | PENDING | Worker scans and operator-global readers need one audit | Document every `dbOperator` exception before migration. |

## Per-domain completion evidence

For each row, link the pull request or test names that prove all of the
following before changing the status to **COMPLETE**:

1. REST, public API, MCP, worker, and UI-triggered routes were inventoried;
   absent entry points are explicitly recorded.
2. Normal reads and writes run inside `runWithTenant(resourceOrganizationId, …)`.
3. Interactive transactions use `tenantTransaction`; a `dbOperator` use is
   limited to a documented cross-tenant candidate scan and borrows the row's
   tenant lane before domain work.
4. A two-tenant real-Postgres test proves positive access, cross-tenant refusal,
   and unset-lane refusal.
5. The relevant `check-tenant-als.sh` allow-list and tests have been updated.
