/**
 * Client-safe classifier for email-template slugs.
 *
 * The system-template list lives in the registry leaf
 * (`email-template-registry.ts`, no server imports), so this module reads it
 * rather than mirroring it: there is no second copy to drift. Client
 * components (the bulk-email dialog) use the classifiers below to tell a
 * *custom* template (one an organizer created) apart from a *system* default.
 *
 * Leaf module: imports only the registry leaf, safe for any bundle.
 */
import { SYSTEM_TEMPLATE_SLUG_LIST } from "@/lib/email-template-registry";

export const SYSTEM_TEMPLATE_SLUGS: ReadonlySet<string> = new Set(SYSTEM_TEMPLATE_SLUG_LIST);

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
  "certificate-attendance-delivery": "Certificate (attendance)",
  "certificate-appreciation-delivery": "Certificate (appreciation)",
  "certificate-bundle-delivery": "Certificate (bundle)",
  "document-delivery": "Document Delivery",
  "custom-notification": "Custom Email",
  // Label only — the SLUG stays `dinner-rsvp-invitation` because 17 events
  // already hold a materialised row on it. A label moves no data; a slug is a key.
  "dinner-rsvp-invitation": "RSVP Invitation",
  "speaker-reimbursement-invitation": "Reimbursement Invitation",
  "travel-grant-invitation": "Travel Grant Invitation",
  "speaker-reimbursement-received": "Reimbursement Received",
  "speaker-profile-form-request": "Speaker Profile Form Request",
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
