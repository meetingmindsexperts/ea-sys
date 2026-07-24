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
  "certificate-bundle-delivery",
  "document-delivery",
  "registration-confirmation",
  "speaker-invitation",
  "speaker-agreement",
  "presenter-agreement",
  "event-reminder",
  "abstract-submission-confirmation",
  "abstract-status-update",
  "submitter-welcome",
  "abstract-reminder",
  "reviewer-assignment",
  "reviewer-pool-invitation",
  "custom-notification",
  "payment-confirmation",
  "payment-reminder",
  "refund-confirmation",
  "survey-invitation",
  "survey-thankyou",
  "dinner-rsvp-invitation",
  "speaker-reimbursement-invitation",
  "speaker-reimbursement-received",
  "webinar-confirmation",
  "webinar-live-now",
  "webinar-panelist-invitation",
  "webinar-reminder-1h",
  "webinar-reminder-24h",
  "webinar-thank-you",
]);

/**
 * The auto-webinar email-sequence templates. These only make sense on a
 * WEBINAR event (they're sent by the webinar sequence), so they're hidden from
 * the Email Templates list on non-webinar events. Derived from
 * `SYSTEM_TEMPLATE_SLUGS` (the `webinar-` prefix) so it can never drift from it.
 */
export const WEBINAR_TEMPLATE_SLUGS: ReadonlySet<string> = new Set(
  [...SYSTEM_TEMPLATE_SLUGS].filter((s) => s.startsWith("webinar-")),
);

/** True for a webinar-sequence system template (see `WEBINAR_TEMPLATE_SLUGS`). */
export function isWebinarTemplateSlug(slug: string): boolean {
  return WEBINAR_TEMPLATE_SLUGS.has(slug);
}

/**
 * True when a slug is NOT a system default — i.e. an organizer-created custom
 * template that the bulk-email dialog should offer as a selectable send option.
 */
export function isCustomTemplateSlug(slug: string): boolean {
  return !SYSTEM_TEMPLATE_SLUGS.has(slug);
}

/**
 * Human-readable labels for slugs that don't Title-case cleanly. Anything not
 * listed here falls back to kebab → Title Case (with a few acronyms preserved),
 * so a brand-new slug renders reasonably without needing an entry.
 *
 * Note: `certificate-delivery` is a synthetic slug the cert pipeline threads
 * onto its EmailLog rows (not a stored EmailTemplate), so it lives here too.
 */
const TEMPLATE_LABEL_OVERRIDES: Readonly<Record<string, string>> = {
  "certificate-delivery": "Certificate",
  "certificate-bundle-delivery": "Certificate (bundle)",
  "document-delivery": "Document Delivery",
  "custom-notification": "Custom Email",
  "dinner-rsvp-invitation": "Dinner RSVP Invitation",
  "speaker-reimbursement-invitation": "Reimbursement Invitation",
  "speaker-reimbursement-received": "Reimbursement Received",
  "webinar-reminder-1h": "Webinar Reminder (1h)",
  "webinar-reminder-24h": "Webinar Reminder (24h)",
};

/** Words to keep as acronyms when Title-casing a slug. */
const TEMPLATE_LABEL_ACRONYMS: Readonly<Record<string, string>> = {
  rsvp: "RSVP",
  cme: "CME",
  qa: "Q&A",
};

/**
 * A friendly display label for an email-template slug — e.g.
 * `speaker-invitation` → "Speaker Invitation", `webinar-reminder-24h` →
 * "Webinar Reminder (24h)". A null/absent slug (a raw one-off send with no
 * template) reads as "Custom email". Client-safe (leaf module, no imports).
 */
export function formatTemplateLabel(slug: string | null | undefined): string {
  if (!slug) return "Custom email";
  const override = TEMPLATE_LABEL_OVERRIDES[slug];
  if (override) return override;
  return slug
    .split("-")
    .map(
      (word) =>
        TEMPLATE_LABEL_ACRONYMS[word] ??
        (word.length ? word.charAt(0).toUpperCase() + word.slice(1) : word),
    )
    .join(" ");
}
