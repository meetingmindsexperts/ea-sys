/**
 * Built-in CRM email templates — a small, fixed set of starting points for the
 * compose dialog (sponsor blast + per-deal email). Client-safe (no `db`).
 *
 * These are PRE-FILL only: picking one drops its subject + body into the editable
 * fields, and those fields drive the send (same pattern as the certificate
 * cover-email source picker). They are NOT stored, per-org, or editable — the ask
 * was "2 or 3", not a template CMS. If per-org editable templates are ever wanted,
 * that's a table + CRUD, not this.
 *
 * Bodies deliberately DON'T repeat the "Dear {{firstName}}," greeting — the send
 * pipeline bakes that in, so a template starts at the first real sentence. The only
 * tokens the sender-authored body/subject resolve are firstName / lastName /
 * companyName / eventName (see substituteBodyTokens in the service). `{{eventName}}`
 * renders empty for a deal with no linked event, which reads fine.
 */
export interface CrmEmailTemplate {
  id: string;
  label: string;
  subject: string;
  /** HTML body fragment (no greeting, no signature — the pipeline adds those). */
  body: string;
}

export const CRM_EMAIL_TEMPLATES: readonly CrmEmailTemplate[] = [
  {
    id: "prospectus",
    label: "Sponsorship prospectus",
    subject: "Sponsorship opportunities — {{eventName}}",
    body:
      "<p>We&rsquo;d be delighted to have {{companyName}} partner with us on {{eventName}}. " +
      "I&rsquo;ve attached our sponsorship prospectus, which sets out the packages and the audience you&rsquo;ll reach.</p>" +
      "<p>I&rsquo;d be glad to walk you through the options and tailor something to your goals — just let me know a good time to talk.</p>",
  },
  {
    id: "followup",
    label: "Follow-up",
    subject: "Following up on {{eventName}} sponsorship",
    body:
      "<p>I wanted to follow up on the sponsorship details for {{eventName}} I sent across. " +
      "Have you had a chance to consider how {{companyName}} might like to be involved?</p>" +
      "<p>Happy to answer any questions or adjust a package to fit your budget — just reply and we&rsquo;ll take it from there.</p>",
  },
  {
    id: "thankyou",
    label: "Thank you",
    subject: "Thank you from the {{eventName}} team",
    body:
      "<p>Thank you for your time and for considering a partnership with us on {{eventName}}. " +
      "It&rsquo;s a pleasure working with {{companyName}}.</p>" +
      "<p>If there&rsquo;s anything else you need from us, just let me know.</p>",
  },
];
