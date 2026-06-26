/**
 * Client-safe classifier for email-template slugs.
 *
 * The authoritative source of system templates is `DEFAULT_TEMPLATES` in
 * `src/lib/email.ts`, but that module pulls in server-only code (a lazy `db`
 * import, the Pino logger). Client components (the bulk-email dialog) need to
 * tell a *custom* template (one an organizer created) apart from a *system*
 * default without importing that module — so this leaf module mirrors just the
 * slug list. A vitest (`email-template-slugs.test.ts`) asserts this mirror
 * stays in sync with `DEFAULT_TEMPLATES`, so drift fails CI rather than
 * silently mis-classifying a template.
 *
 * Leaf module: no imports, safe for any bundle.
 */
export const SYSTEM_TEMPLATE_SLUGS: ReadonlySet<string> = new Set([
  "registration-confirmation",
  "speaker-invitation",
  "speaker-agreement",
  "event-reminder",
  "abstract-submission-confirmation",
  "abstract-status-update",
  "submitter-welcome",
  "abstract-reminder",
  "reviewer-assignment",
  "custom-notification",
  "payment-confirmation",
  "payment-reminder",
  "refund-confirmation",
  "survey-invitation",
  "survey-thankyou",
  "webinar-confirmation",
  "webinar-live-now",
  "webinar-panelist-invitation",
  "webinar-reminder-1h",
  "webinar-reminder-24h",
  "webinar-thank-you",
]);

/**
 * True when a slug is NOT a system default — i.e. an organizer-created custom
 * template that the bulk-email dialog should offer as a selectable send option.
 */
export function isCustomTemplateSlug(slug: string): boolean {
  return !SYSTEM_TEMPLATE_SLUGS.has(slug);
}
