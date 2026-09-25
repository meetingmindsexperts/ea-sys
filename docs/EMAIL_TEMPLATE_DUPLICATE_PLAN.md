# Duplicate an email template: plan

BUILT September 25, 2026 (planned September 24); copy to another event is not in scope. Owner: "give an option to clone or
duplicate a template manually and for the AI agent; starting state is disabled,
set active, slug will be different."

## Why

On prod at 13:49 UTC an organiser asked the Event Agent to "create a duplicate
template of the speaker invitation". It could not. `list_email_templates`
returns metadata only (id, name, subject, slug, isActive), and no tool reads a
template's body, so the agent asked the person to paste the HTML. The
dashboard has no copy action either; the manual path today is New template and
paste the body by hand.

## Behaviour

- **What is copied:** name, subject, HTML body, text body. Nothing else exists
  on the row to copy.
- **Name:** `<source name> (copy)`; a second copy of the same source is
  `(copy 2)`, and so on.
- **Slug:** `<source slug>-copy`, then `-copy-2`, `-copy-3`, trimmed to the
  100-character slug limit. Always a CUSTOM slug, so the copy never collides
  with or shadows a built-in (`isCustomTemplateSlug` must hold; assert it).
- **Starts disabled** (`isActive: false`). What that means today, verified in
  code: the bulk-email dialog lists only active custom templates
  (`bulk-email-dialog.tsx:397`), and `loadActiveEventTemplateRow` treats an
  inactive row as absent. So a copy cannot be sent until someone switches it
  on; the templates page already has the Active/Disabled filter and the editor
  already saves `isActive` through the existing PUT.
- **Source may be a built-in with no event row yet.** The GET seeds built-ins
  on first list, but a direct call can race that; fall back to the
  `DEFAULT_TEMPLATES` entry for the slug.
- **Tokens:** the copy keeps the source text as is, and its tokens keep
  working. A custom template sent to speakers gets the same speaker context as
  the built-in (`bulk-email.ts`: `recipientType === "speakers"` builds
  `buildSpeakerEmailContext`), so `{{speakerName}}`, `{{presentationDetails}}`,
  `{{moderatorDetails}}`, `{{agreementBlock}}` and the honorarium tokens all
  fill (corrected Sep 25: the first draft wrongly said they would not).
  Speaker tokens only fill when the audience is speakers, which is true of the
  built-in too. Tokens are reported, not refused, even on the agent door: the
  agent copied the text, it did not invent it.
- **Checker gap found while checking:** `{{honorarium}}`,
  `{{honorariumAmount}}` and `{{honorariumCurrency}}` are filled on every
  speaker send but are missing from `BULK_BASE_VARIABLES`
  (`email-template-registry.ts`), so a custom template using them is flagged
  as having unknown tokens (and the agent's create refuses them). Add the
  three to the list and to its pinning test as part of this work.

## Build

1. **One function** `duplicateEmailTemplate({ eventId, sourceSlug | sourceId })`
   in `src/lib/email-template-create.ts`, beside `createCustomEmailTemplate`,
   which gains an optional `isActive` (default true, so no current caller
   changes). It resolves the source, picks the first free `-copy[-n]` slug,
   creates with `isActive: false`, and retries the next suffix on the
   `SLUG_TAKEN` race (a few tries, then a clear error). Codes:
   `SOURCE_NOT_FOUND`, `NO_FREE_SLUG`.
2. **REST:** `POST /api/events/[eventId]/email-templates/[templateId]/duplicate`,
   a new route file (the `[templateId]` file already uses POST for the test
   send). Same guards as the create route: `requireOrgId`,
   `denyReviewer(allow: WEBINAR_STAFF_ALLOW)`, `buildEventAccessWhere`, audit
   `CREATE` with `duplicatedFrom`. 201 with the row; 404 / 409 mapped and
   logged.
3. **Agent tool** `duplicate_email_template` (params: `slug`, optional `name`)
   in `src/lib/agent/tools/communications.ts` plus its schema in
   `register-mcp-tools.ts`. A write tool, no approval card (it creates a
   disabled row; nothing sends). Add it to `dashboardPathForTool` so the reply
   links to the new template, and say in the reply that it starts disabled.
   Update `list_email_templates`'s description to point at it, so the next
   "duplicate" request does not dead-end again.
4. **UI:** a Duplicate button (Copy icon) on every template card, built-in and
   custom, in `communications/templates/page.tsx`, beside Edit; toast
   "Copied as <name>. It starts disabled; switch it on when ready." and open
   the copy's editor.
5. **Tests:** name/slug numbering incl. the length trim, the built-in-without-
   row fallback, the race retry, `isActive:false`, the route's guards and
   codes, the tool (write-tool, not approval, reply wording), the dashboard
   link. Mutation-check the suffix loop and the disabled default.
6. **Docs:** `docs/MCP_REFERENCE.md`, a golden task in
   `docs/AGENT_GOLDEN_TASKS.md` ("duplicate the speaker invitation"), user
   guide communications chapter, CHANGELOG. Bump `package.json` version (and
   the lockfile) for the MCP tool-list change; connected MCP clients must
   reconnect to see it.

## Open questions for the owner

- Should Duplicate also copy to ANOTHER event (the common "reuse last year's
  wording" case)? Not in this plan; it would need an event picker and the
  access check on the target.
- None on tokens: they carry over and work (see Behaviour).
