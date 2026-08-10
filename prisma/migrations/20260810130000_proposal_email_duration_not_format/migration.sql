-- Session-proposal confirmation email: Duration replaces Format, Theme drops.
--
-- Format was removed from every submitter surface on Aug 4, 2026 (form, list,
-- sheet, CSV) but the email kept rendering {{proposalFormat}}, so it printed a
-- value nobody could set. The theme row goes with it.
--
-- Why a data migration and not just a code change: the templates list GET
-- auto-seeds system defaults as editable EmailTemplate rows, and getEventTemplate
-- prefers a saved row over the default. renderTemplate leaves unknown keys as
-- LITERAL text, so changing only the default would make every event with a saved
-- row email a proposer the string "{{proposalTheme}}". Ten rows existed at
-- authoring time and all ten matched the seeded markup byte for byte.
--
-- Surgical on purpose: the WHERE guard plus the exact-fragment match means a
-- genuinely customized template is left alone rather than rewritten. Anything
-- not matching keeps its old rows, which the sender still fills with empty
-- strings so they render blank instead of as literal tokens.
--
-- Idempotent: the pattern is gone after the first run, so a re-run updates
-- nothing. No schema change.

UPDATE "EmailTemplate"
SET "htmlContent" = REPLACE(
      "htmlContent",
      '        <tr><td style="padding: 8px 0; color: #6b7280;">Theme:</td><td style="padding: 8px 0; font-weight: 500;">{{proposalTheme}}</td></tr>' || E'\n' ||
      '        <tr><td style="padding: 8px 0; color: #6b7280;">Format:</td><td style="padding: 8px 0; font-weight: 500;">{{proposalFormat}}</td></tr>',
      '        <tr><td style="padding: 8px 0; color: #6b7280;">Duration:</td><td style="padding: 8px 0; font-weight: 500;">{{proposalDuration}}</td></tr>'
    )
WHERE slug = 'session-proposal-confirmation'
  AND "htmlContent" LIKE '%{{proposalTheme}}%';

UPDATE "EmailTemplate"
SET "textContent" = REPLACE(
      "textContent",
      '- Theme: {{proposalTheme}}' || E'\n' || '- Format: {{proposalFormat}}',
      '- Duration: {{proposalDuration}}'
    )
WHERE slug = 'session-proposal-confirmation'
  AND "textContent" LIKE '%{{proposalTheme}}%';
