-- Reimbursement domain (Domain #17) — flat tenant-isolation policies for
-- SpeakerReimbursement (1-hop from Event) + SpeakerReimbursementDocument
-- (2-hop via SpeakerReimbursement). Aug 3, 2026.
--
-- Applied ONLY by the tenancy harness (tests/tenancy/global-setup.ts) and the
-- future platform bootstrap — NEVER a prisma migration, so master's DB keeps
-- zero RLS objects. NO FORCE: enforcement is the non-owner app_user role
-- (owners bypass; the harness two-role split is the platform's reference
-- architecture). Fail-closed on an unset GUC.
--
-- Domain notes:
--   - SpeakerReimbursement.token is GLOBALLY unique and plaintext (the
--     copyable link) — the public routes therefore bootstrap the org from the
--     un-swept Event by host+slug (resolveReimbursementEventOrg) BEFORE the
--     token findUnique, or every link would fail-close to "invalid".
--   - speakerId is also globally unique (one form per speaker) — a
--     cross-tenant findUnique({ speakerId }) must miss.
--   - The dashboard console + document-stream routes authorize via
--     buildEventAccessWhere and wrap in the RESOURCE org (org-null
--     SUPER_ADMIN reaches them).

ALTER TABLE "SpeakerReimbursement" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS speakerreimbursement_tenant_isolation ON "SpeakerReimbursement";
CREATE POLICY speakerreimbursement_tenant_isolation ON "SpeakerReimbursement"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));

ALTER TABLE "SpeakerReimbursementDocument" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS speakerreimbursementdocument_tenant_isolation ON "SpeakerReimbursementDocument";
CREATE POLICY speakerreimbursementdocument_tenant_isolation ON "SpeakerReimbursementDocument"
  FOR ALL TO PUBLIC
  USING ("organizationId" = current_setting('app.current_org', true))
  WITH CHECK ("organizationId" = current_setting('app.current_org', true));
