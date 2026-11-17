-- Row-level security for Event (Event RLS step 6, Nov 17 2026).
--
-- Flat policy on the row's own organizationId, the shape of every tenant
-- table (prisma/rls/contact.sql is the annotated template: why no FORCE, where
-- this runs, the refuse-to-boot tripwire). Applied by the tenancy harness and
-- the platform bootstrap, NEVER by a prisma migration: master's database holds
-- no RLS objects.
--
-- WHY EVENT CAME LAST. Every other policied table is read inside a lane the
-- caller already has. Event is how many requests FIND their lane (a public
-- page knows a slug, a reviewer knows an event id), so a policy here was
-- fail-closed for the whole product until every read of Event ran inside a
-- lane. That was three sweeps (Nov 16 and 17, 2026): the staff API through
-- findGatedEvent, public addresses through findPublicEvent, lists, dashboard
-- pages, the agent's tools and the worker, each through its door in
-- src/lib/tenant/event-tenant.ts. __tests__/lib/event-lane-ratchet.test.ts
-- refuses a new query outside a lane.
--
-- THE ONE READ MADE BEFORE A LANE EXISTS is resolveEventTenant in that file:
-- for a reviewer, submitter or registrant, who reaches an event by their link
-- to it. It returns the id and the organisation only, and reads through the
-- privileged client (dbOperator), which connects as the table owner and so is
-- not bound by this policy.
--
-- Until this file existed the same policy lived in
-- tests/tenancy/policies/10-event-rls.sql as a harness-only pilot (it proved
-- the transport: tenant store, SET LOCAL through pgbouncer, the policy).
--
-- Fails closed: with app.current_org unset, current_setting(..., true) returns
-- NULL and the comparison matches nothing. Idempotent: safe to re-run.

ALTER TABLE "Event" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS event_tenant_isolation ON "Event";
CREATE POLICY event_tenant_isolation ON "Event"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));
