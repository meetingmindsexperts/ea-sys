/**
 * The email-template registry: ONE entry per system template, from which
 * everything that used to be a hand-copied list is derived.
 *
 * Before September 18, 2026 the same facts lived in about twelve places:
 * `DEFAULT_TEMPLATES` (bodies), `TEMPLATE_VARIABLES` (what each template may
 * use), `DEFAULT_RAW_HTML_KEYS`, the client-safe slug mirror, the bulk
 * type-to-slug map, the two single-send routes' maps, the registration sheet's
 * map, the dialog's per-audience option lists, the Settings tab's short list
 * and the templates page's descriptions. Five of those were type-to-slug maps
 * that all agreed a type existed and none knew what its template needed,
 * which is how the bulk Registration Confirmation was refused for every
 * recipient on most events (docs/CODE_REVIEW_EMAIL_TEMPLATES.html, finding 1).
 *
 * Structure: this file is a LEAF (no server imports, so any client bundle may
 * read it) holding the metadata; the default subject and bodies live next door
 * in `email-template-defaults.ts`, keyed by the same slug type, so the compiler
 * refuses a template that exists in one file and not the other. Adding a
 * system template is one entry here plus one body there.
 *
 * `variables` lists the tokens the template's SENDERS fill beyond the global
 * event block (`GLOBAL_EVENT_VARIABLES` in email.ts). `rawHtmlKeys` are the
 * block tokens whose values are our own markup; they join `DEFAULT_RAW_HTML_KEYS`
 * so no caller has to remember them. A `*Text` mirror of a block token (the
 * plain-text part) is deliberately not advertised.
 */
import { CERT_COVER_TEMPLATE_NAMES, CERT_BUNDLE_COVER_TEMPLATE_NAME } from "@/lib/certificates/email-tokens";

/** The system templates, in the order they are seeded onto an event. */
export const SYSTEM_TEMPLATE_SLUG_LIST = [
  "registration-confirmation",
  "speaker-invitation",
  "speaker-agreement",
  "presenter-agreement",
  "event-reminder",
  "abstract-submission-confirmation",
  "session-proposal-confirmation",
  "group-registration-confirmation",
  "abstract-status-update",
  "submitter-welcome",
  "session-proposal-welcome",
  "reviewer-assignment",
  "reviewer-pool-invitation",
  "abstract-reminder",
  "custom-notification",
  "payment-confirmation",
  "refund-confirmation",
  "payment-reminder",
  "webinar-confirmation",
  "webinar-reminder-24h",
  "webinar-reminder-1h",
  "webinar-live-now",
  "webinar-thank-you",
  "webinar-panelist-invitation",
  "survey-invitation",
  "survey-thankyou",
  "certificate-attendance-delivery",
  "certificate-appreciation-delivery",
  "certificate-bundle-delivery",
  "document-delivery",
  "dinner-rsvp-invitation",
  "travel-grant-invitation",
  "speaker-reimbursement-invitation",
  "speaker-profile-form-request",
  "speaker-reimbursement-received",
] as const;

export type SystemTemplateSlug = (typeof SYSTEM_TEMPLATE_SLUG_LIST)[number];

/** Who a template is written to. */
export type EmailRecipientKind = "registration" | "speaker" | "reviewer" | "coordinator" | "any";

/**
 * Where a template can be sent from. `automatic`: the system sends it when
 * something happens. `registration` / `speaker`: the Send Email menu on one
 * person's record. `bulk`: Communications. `console`: a dedicated console
 * (RSVP, reimbursement, travel grant, profile form, panelists, presenter
 * agreement). `certificates`: the certificate pipeline's cover emails.
 */
export type EmailTemplateSurface = "automatic" | "registration" | "speaker" | "bulk" | "console" | "certificates";

/** The Communications audiences a bulk send can target. */
export type BulkEmailAudience = "registrations" | "speakers" | "reviewers" | "abstracts";

export interface TemplateVariable {
  key: string;
  description: string;
}

export interface BulkAudienceEntry {
  audience: BulkEmailAudience;
  /** Position in that audience's dropdown (0 first). */
  order: number;
  /** Wording for this audience when it differs from the default description. */
  description?: string;
}

export interface BulkSendSpec {
  /** The `emailType` the bulk pipeline and the dialog use for this template. */
  type: string;
  label: string;
  description: string;
  /** Dropdown placement; empty for a type the pipeline sends but nobody picks (the webinar sequence). */
  audiences: readonly BulkAudienceEntry[];
}

export interface SingleSendSpec {
  /** The per-person menu it appears on. */
  surface: "registration" | "speaker";
  /** The `type` the single-send route accepts. */
  type: string;
  label: string;
  /** The speaker page previews this slug but sends it through another route. */
  previewOnly?: boolean;
}

export interface EmailTemplateSpec {
  slug: SystemTemplateSlug;
  name: string;
  /** One line for the templates list. */
  description: string;
  recipient: EmailRecipientKind;
  surfaces: readonly EmailTemplateSurface[];
  /** Shown in the Event Settings tab's short list. */
  core?: boolean;
  bulk?: BulkSendSpec;
  single?: readonly SingleSendSpec[];
  variables: readonly TemplateVariable[];
  rawHtmlKeys: readonly string[];
}

/**
 * Block tokens that resolve on ANY template of their audience, not one
 * template's own: the sender builds them for every send it makes.
 */
export const GLOBAL_RAW_HTML_KEYS: readonly string[] = [
  // The sender's own profile signature (User.emailSignature, Tiptap HTML).
  "organizerSignature",
  // The personal RSVP link as a button (src/lib/rsvp/button.ts).
  "rsvpButton",
  // The entry-barcode image block (src/lib/email-barcode.ts).
  "entryBarcode",
  // The speaker blocks (src/lib/speaker-agreement.ts).
  "presentationDetails",
  "moderatorDetails",
  "agreementBlock",
  // The travel-grant offer (src/lib/travel-grant/block.ts); empty for an ineligible author.
  "travelGrantBlock",
];

export const EMAIL_TEMPLATE_REGISTRY: Readonly<Record<SystemTemplateSlug, EmailTemplateSpec>> = {
  "registration-confirmation": {
    slug: "registration-confirmation",
    name: "Registration Confirmation",
    description: "Sent when someone registers, and when staff add a registration that owes money; carries the payment box and the quote",
    recipient: "registration",
    surfaces: ["automatic", "registration", "bulk"],
    core: true,
    bulk: { type: "confirmation", label: "Registration Confirmation", description: "Confirm their registration", audiences: [{ audience: "registrations", order: 0 }] },
    single: [{ surface: "registration", type: "confirmation", label: "Registration Confirmation" }],
    variables: [
    { key: "title", description: "Attendee title prefix with period (e.g. Dr., Prof., Mr., Mrs., Ms.)" },
    { key: "firstName", description: "Attendee first name" },
    { key: "lastName", description: "Attendee last name" },
    { key: "eventName", description: "Event name" },
    { key: "eventDate", description: "Event START date, no time (e.g. Friday, October 2, 2026)" },
    { key: "eventStartDate", description: "Same as eventDate — the start date, spelled out" },
    { key: "eventDateRange", description: "First to last day (e.g. October 2 – 3, 2026); collapses to the single date on a one-day event" },
    { key: "eventVenue", description: "Event venue" },
    { key: "eventCity", description: "Event city" },
    { key: "eventCountry", description: "Event country" },
    { key: "ticketType", description: "Registration/ticket type" },
    { key: "registrationId", description: "Confirmation number" },
    { key: "paymentBlock", description: "Payment pending block (auto-generated for paid tickets)" },
    { key: "entryBarcode", description: "Attendee entry barcode image — in-person registrations only (omit to exclude it)" },
    { key: "organizerSignature", description: "Sender's personal email signature (HTML, from Profile → Email Signature) — empty on automated sends" },
    ],
    rawHtmlKeys: ["paymentBlock"],
  },
  "speaker-invitation": {
    slug: "speaker-invitation",
    name: "Speaker Invitation",
    description: "Sent when inviting a speaker to the event; carries the Review & Agree button when the template has {{agreementBlock}}",
    recipient: "speaker",
    surfaces: ["speaker", "bulk"],
    core: true,
    bulk: { type: "invitation", label: "Speaker Invitation", description: "Invite speakers to your event", audiences: [{ audience: "speakers", order: 0 }] },
    single: [{ surface: "speaker", type: "invitation", label: "Speaker Invitation" }],
    variables: [
    { key: "title", description: "Speaker title prefix (e.g. Dr.)" },
    { key: "firstName", description: "Speaker first name" },
    { key: "lastName", description: "Speaker last name" },
    { key: "speakerName", description: "Full prefixed speaker name" },
    { key: "eventName", description: "Event name" },
    { key: "eventDate", description: "Event date (formatted)" },
    { key: "eventVenue", description: "Event venue" },
    { key: "eventCity", description: "Event city" },
    { key: "eventCountry", description: "Event country" },
    { key: "personalMessage", description: "Personal message from organizer" },
    { key: "presentationDetails", description: "Pre-rendered presentation details block — a 'Your Presentation Details:' heading + the person's SPEAKING engagements only; sessions they moderate/chair render in {{moderatorDetails}} instead (HTML)" },
    { key: "moderatorDetails", description: "Sessions this speaker MODERATES or CHAIRS — a 'Your Moderation Details:' heading + Topic | Presented by run-sheet (HTML; empty when they run no session)" },
    { key: "honorarium", description: "Honorarium / speaker fee agreed by the organiser, e.g. USD 1,500.00 (0.00 when none is set); {{honorariumAmount}} and {{honorariumCurrency}} carry the parts" },
    { key: "agreementBlock", description: "Pre-rendered Review & Agree button (CTA-only — add your own intro wording around the token); shows an already-signed note for speakers who accepted" },
    { key: "agreementBlockText", description: "Plain-text variant of the agreement block (for the text part)" },
    { key: "agreementLink", description: "Bare one-time agreement URL (minted when the template uses an agreement token)" },
    { key: "agreementAttachment", description: "Invisible marker — attaches the personalized agreement PDF/.docx to the email WITHOUT rendering the Review & Agree block or minting a link (renders as nothing; skipped for speakers who already signed)" },
    { key: "organizerName", description: "Organizer name" },
    { key: "organizerEmail", description: "Organizer email" },
    { key: "organizerSignature", description: "Sender's personal email signature (HTML)" },
    ],
    rawHtmlKeys: [],
  },
  "speaker-agreement": {
    slug: "speaker-agreement",
    name: "Invited Faculty Participation Agreement",
    description: "Sent with speaker agreement terms and the personalised agreement attached",
    recipient: "speaker",
    surfaces: ["speaker", "bulk"],
    core: true,
    bulk: { type: "agreement", label: "Speaker Agreement", description: "Send agreement terms for review", audiences: [{ audience: "speakers", order: 1 }] },
    single: [{ surface: "speaker", type: "agreement", label: "Speaker Agreement" }],
    variables: [
    { key: "title", description: "Speaker title prefix (e.g. Dr.)" },
    { key: "firstName", description: "Speaker first name" },
    { key: "lastName", description: "Speaker last name" },
    { key: "speakerName", description: "Full prefixed speaker name" },
    { key: "eventName", description: "Event name" },
    { key: "eventDate", description: "Event date (formatted)" },
    { key: "eventVenue", description: "Event venue" },
    { key: "eventCity", description: "Event city" },
    { key: "eventCountry", description: "Event country" },
    { key: "sessionDetails", description: "Session details" },
    { key: "presentationDetails", description: "Pre-rendered presentation details block — a 'Your Presentation Details:' heading + the person's SPEAKING engagements only; sessions they moderate/chair render in {{moderatorDetails}} instead (HTML)" },
    { key: "moderatorDetails", description: "Sessions this speaker MODERATES or CHAIRS — a 'Your Moderation Details:' heading + Topic | Presented by run-sheet (HTML; empty when they run no session)" },
    { key: "honorarium", description: "Honorarium / speaker fee agreed by the organiser, e.g. USD 1,500.00 (0.00 when none is set); {{honorariumAmount}} and {{honorariumCurrency}} carry the parts" },
    { key: "agreementLink", description: "Agreement link URL" },
    { key: "agreementAttachment", description: "Invisible marker — attaches the personalized agreement PDF/.docx to the email WITHOUT rendering the Review & Agree block or minting a link (renders as nothing; skipped for speakers who already signed)" },
    { key: "organizerName", description: "Organizer name" },
    { key: "organizerEmail", description: "Organizer email" },
    { key: "organizerSignature", description: "Sender's personal email signature (HTML)" },
    { key: "personalMessage", description: "The message typed in the send dialog (optional)" },
    ],
    rawHtmlKeys: [],
  },
  "presenter-agreement": {
    slug: "presenter-agreement",
    name: "Presenter Agreement",
    description: "Sent to an abstract presenter with their agreement link",
    recipient: "speaker",
    surfaces: ["console"],
    variables: [
    { key: "title", description: "Presenter title prefix (e.g. Dr.)" },
    { key: "firstName", description: "Presenter first name" },
    { key: "lastName", description: "Presenter last name" },
    { key: "presenterName", description: "Full prefixed presenter (author) name" },
    { key: "presenterEmail", description: "Presenter email" },
    { key: "eventName", description: "Event name" },
    { key: "eventDateRange", description: "Event date range (formatted, with leading separator)" },
    { key: "eventVenue", description: "Event venue" },
    { key: "eventCity", description: "Event city" },
    { key: "eventCountry", description: "Event country" },
    { key: "abstractTitles", description: "The presenter's submitted abstract titles (joined)" },
    { key: "abstractCount", description: "Number of abstracts the presenter submitted" },
    { key: "agreementLink", description: "Agreement acceptance link URL" },
    { key: "organizerName", description: "Organizer name" },
    { key: "organizerEmail", description: "Organizer email" },
    { key: "organizerSignature", description: "Sender's personal email signature (HTML)" },
    { key: "personalMessage", description: "The message typed in the send dialog (optional)" },
    ],
    rawHtmlKeys: [],
  },
  "event-reminder": {
    slug: "event-reminder",
    name: "Event Reminder",
    description: "Sent as a reminder before the event",
    recipient: "registration",
    surfaces: ["registration", "bulk"],
    core: true,
    bulk: { type: "reminder", label: "Event Reminder", description: "Remind about the upcoming event", audiences: [{ audience: "registrations", order: 1 }] },
    single: [{ surface: "registration", type: "reminder", label: "Event Reminder" }],
    variables: [
    { key: "title", description: "Recipient title prefix with period (e.g. Dr., Prof., Mr., Mrs., Ms.)" },
    { key: "firstName", description: "Recipient first name" },
    { key: "lastName", description: "Recipient last name" },
    { key: "eventName", description: "Event name" },
    { key: "eventDate", description: "Event date (formatted)" },
    { key: "eventVenue", description: "Event venue" },
    { key: "eventCity", description: "Event city" },
    { key: "eventCountry", description: "Event country" },
    { key: "eventAddress", description: "Event address" },
    { key: "daysUntilEvent", description: "Number of days until event" },
    { key: "entryBarcode", description: "Attendee entry barcode image — in-person registrations only (omit to exclude it)" },
    { key: "organizerSignature", description: "Sender's personal email signature (HTML, from Profile → Email Signature) — empty on automated sends" },
    ],
    rawHtmlKeys: [],
  },
  "abstract-submission-confirmation": {
    slug: "abstract-submission-confirmation",
    name: "Abstract Submission Confirmation",
    description: "Sent when a speaker submits an abstract; carries the travel-grant offer for an eligible author",
    recipient: "speaker",
    surfaces: ["automatic", "speaker", "bulk"],
    core: true,
    bulk: { type: "abstract-confirmation", label: "Resend Submission Confirmation", description: "One email per abstract, with its number, title and details", audiences: [{ audience: "abstracts", order: 0 }] },
    single: [{ surface: "speaker", type: "abstract-confirmation", label: "Abstract Confirmation", previewOnly: true }],
    variables: [
    { key: "title", description: "Submitter title prefix with period (e.g. Dr., Prof., Mr., Mrs., Ms.)" },
    { key: "firstName", description: "Speaker first name" },
    { key: "lastName", description: "Speaker last name" },
    { key: "eventName", description: "Event name" },
    { key: "abstractNumber", description: "Abstract number (e.g. A-007) — blank on legacy abstracts without one" },
    { key: "abstractTitle", description: "Abstract title" },
    { key: "presentationType", description: "Presentation type (e.g. Oral, Poster) — blank if not set" },
    { key: "theme", description: "Abstract theme name — blank if none" },
    { key: "authorName", description: "Submitting author's full name (with title)" },
    { key: "coAuthorNames", description: "Co-author names, comma-separated; prints None when the abstract has no co-authors" },
    { key: "managementLink", description: "Abstract management link" },
    {
      key: "travelGrantBlock",
      description:
        "Travel-grant offer (message + button) for an author based outside the event's home country when Travel Grants are switched on; renders as nothing for everyone else. Same block the travel-grant invitation uses, so the two cannot drift. Appended automatically at send time if your saved template does not carry it.",
    },
    { key: "travelGrantBlockText", description: "Plain-text version of the travel-grant block" },
    { key: "organizerSignature", description: "Sender's personal email signature (HTML, from Profile → Email Signature) — empty on automated sends" },
    ],
    rawHtmlKeys: [],
  },
  "session-proposal-confirmation": {
    slug: "session-proposal-confirmation",
    name: "Session Proposal Confirmation",
    description: "Sent when a session proposal is submitted",
    recipient: "speaker",
    surfaces: ["automatic"],
    variables: [
    { key: "title", description: "Proposer title prefix with period (e.g. Dr., Prof., Mr., Mrs., Ms.)" },
    { key: "firstName", description: "Proposer first name" },
    { key: "lastName", description: "Proposer last name" },
    { key: "eventName", description: "Event name" },
    { key: "proposalNumber", description: "Proposal number (e.g. S-007) — blank on legacy proposals without one" },
    { key: "proposalTitle", description: "Session proposal title" },
    { key: "proposalDuration", description: "Requested duration, e.g. \"90 minutes\" — blank if not stated" },
    { key: "managementLink", description: "Login link to view the proposal" },
    { key: "organizerSignature", description: "Sender's personal email signature (HTML, from Profile → Email Signature) — empty on automated sends" },
    ],
    rawHtmlKeys: [],
  },
  "group-registration-confirmation": {
    slug: "group-registration-confirmation",
    name: "Group Registration Confirmation",
    description: "Sent to the coordinator of a group registration with the member table",
    recipient: "coordinator",
    surfaces: ["automatic"],
    variables: [
    { key: "coordinatorName", description: "Group coordinator's full name" },
    { key: "eventName", description: "Event name" },
    { key: "eventDate", description: "Event date" },
    { key: "eventVenue", description: "Event venue and city" },
    { key: "payerName", description: "The company/payer covering the group" },
    { key: "memberCount", description: "Number of group members" },
    { key: "memberSummary", description: "Members table, HTML (auto-generated: name, email, registration type)" },
    { key: "memberSummaryText", description: "Members list, plain text (for the text version of the email)" },
    { key: "totalAmount", description: "Cumulative total incl. tax (e.g. USD 1250.00)" },
    { key: "invoiceNumber", description: "Consolidated invoice number — blank if invoicing failed" },
    { key: "manageGroupLink", description: "Link to the coordinator's My Group portal for this event" },
    { key: "organizerSignature", description: "Sender's personal email signature (HTML) — empty on automated sends" },
    ],
    rawHtmlKeys: ["memberSummary"],
  },
  "abstract-status-update": {
    slug: "abstract-status-update",
    name: "Abstract Status Update",
    description: "Sent when an abstract status changes (accepted, rejected, etc.)",
    recipient: "speaker",
    surfaces: ["automatic", "bulk"],
    core: true,
    bulk: { type: "abstract-decision", label: "Resend Decision", description: "One email per decided abstract, with its current status and reviewer notes", audiences: [{ audience: "abstracts", order: 1 }] },
    variables: [
    { key: "title", description: "Submitter title prefix with period (e.g. Dr., Prof., Mr., Mrs., Ms.)" },
    { key: "firstName", description: "Speaker first name" },
    { key: "lastName", description: "Speaker last name" },
    { key: "eventName", description: "Event name" },
    { key: "abstractTitle", description: "Abstract title" },
    { key: "presentationType", description: "Presentation type (e.g. Oral, Poster) — blank if not set" },
    { key: "theme", description: "Abstract theme name — blank if none" },
    { key: "authorName", description: "Submitting author's full name (with title)" },
    { key: "coAuthorNames", description: "Co-author names, comma-separated; prints None when the abstract has no co-authors" },
    { key: "newStatus", description: "New status (e.g. ACCEPTED)" },
    { key: "statusHeading", description: "Status heading text" },
    { key: "statusMessage", description: "Status description text" },
    { key: "reviewNotes", description: "Reviewer notes" },
    { key: "reviewScore", description: "Review score (0-10)" },
    { key: "managementLink", description: "Abstract management link" },
    { key: "organizerSignature", description: "Sender's personal email signature (HTML, from Profile → Email Signature) — empty on automated sends" },
    ],
    rawHtmlKeys: ["reviewNotes"],
  },
  "submitter-welcome": {
    slug: "submitter-welcome",
    name: "Submitter Welcome",
    description: "Sent when a submitter creates an account",
    recipient: "speaker",
    surfaces: ["automatic"],
    core: true,
    variables: [
    { key: "title", description: "Submitter title prefix with period (e.g. Dr., Prof., Mr., Mrs., Ms.)" },
    { key: "firstName", description: "Submitter first name" },
    { key: "lastName", description: "Submitter last name" },
    { key: "eventName", description: "Event name" },
    { key: "loginLink", description: "Login page link" },
    { key: "presenterFeeBlock", description: "Presenter registration fee + quote note. Renders as NOTHING unless the event has presenter rates and this person was placed on one (plan D2/D3)" },
    { key: "organizerSignature", description: "Sender's personal email signature (HTML, from Profile → Email Signature) — empty on automated sends" },
    ],
    rawHtmlKeys: ["presenterFeeBlock"],
  },
  "session-proposal-welcome": {
    slug: "session-proposal-welcome",
    name: "Session Proposal Welcome",
    description: "Sent when a proposer creates an account",
    recipient: "speaker",
    surfaces: ["automatic"],
    variables: [
    { key: "title", description: "Proposer title prefix with period (e.g. Dr., Prof., Mr., Mrs., Ms.)" },
    { key: "firstName", description: "Proposer first name" },
    { key: "lastName", description: "Proposer last name" },
    { key: "eventName", description: "Event name" },
    { key: "loginLink", description: "Login page link" },
    { key: "organizerSignature", description: "Sender's personal email signature (HTML, from Profile \u2192 Email Signature) \u2014 empty on automated sends" },
    ],
    rawHtmlKeys: [],
  },
  "reviewer-assignment": {
    slug: "reviewer-assignment",
    name: "Reviewer Assignment",
    description: "Sent to a reviewer assigned to a specific abstract",
    recipient: "reviewer",
    surfaces: ["automatic"],
    variables: [
    { key: "firstName", description: "Reviewer first name" },
    { key: "lastName", description: "Reviewer last name" },
    { key: "eventName", description: "Event name" },
    { key: "abstractTitle", description: "Title of the assigned abstract" },
    { key: "role", description: "Reviewer role (e.g. Primary reviewer)" },
    { key: "reviewLink", description: "Link to the reviewer's My Reviews portal" },
    { key: "organizerSignature", description: "Sender's personal email signature (HTML, from Profile → Email Signature) — empty on automated sends" },
    ],
    rawHtmlKeys: [],
  },
  "reviewer-pool-invitation": {
    slug: "reviewer-pool-invitation",
    name: "Reviewer Added to Event",
    description: "Sent to a reviewer added to the event's pool; also the Review Invitation from Communications",
    recipient: "reviewer",
    surfaces: ["automatic", "bulk"],
    bulk: { type: "invitation", label: "Review Invitation", description: "Resend the reviewer pool invitation (the email a reviewer gets when added)", audiences: [{ audience: "reviewers", order: 1 }] },
    variables: [
    { key: "firstName", description: "Reviewer first name" },
    { key: "lastName", description: "Reviewer last name" },
    { key: "eventName", description: "Event name" },
    { key: "reviewLink", description: "Link to the reviewer's My Reviews portal" },
    { key: "organizerSignature", description: "Sender's personal email signature (HTML, from Profile → Email Signature) — empty on automated sends" },
    ],
    rawHtmlKeys: [],
  },
  "abstract-reminder": {
    slug: "abstract-reminder",
    name: "Abstract Submission Reminder",
    description: "Sent to authors who still have a draft",
    recipient: "speaker",
    surfaces: ["bulk"],
    bulk: { type: "abstract-reminder", label: "Submission Reminder", description: "Authors who still have a draft; add a message", audiences: [{ audience: "abstracts", order: 2 }] },
    variables: [
    { key: "title", description: "Author title, e.g. Dr. (empty when none is recorded)" },
    { key: "firstName", description: "Author first name" },
    { key: "lastName", description: "Author last name" },
    { key: "managementLink", description: "Link to the author's abstracts page" },
    { key: "subject", description: "The subject typed in the send dialog (optional)" },
    { key: "message", description: "The message typed in the send dialog (optional)" },
    { key: "organizerSignature", description: "The sender's email signature (from their Profile)" },
    ],
    rawHtmlKeys: [],
  },
  "custom-notification": {
    slug: "custom-notification",
    name: "Custom Notification",
    description: "Template for custom/ad-hoc emails; your subject and message fill {{subject}} and {{message}}",
    recipient: "any",
    surfaces: ["registration", "speaker", "bulk"],
    core: true,
    bulk: { type: "custom", label: "Custom Email", description: "Write a custom message", audiences: [{ audience: "speakers", order: 3 }, { audience: "reviewers", order: 0, description: "Write a custom message to reviewers" }, { audience: "registrations", order: 5 }, { audience: "abstracts", order: 3 }] },
    single: [{ surface: "registration", type: "custom", label: "Custom Notification" }, { surface: "speaker", type: "custom", label: "Custom Email" }],
    variables: [
    { key: "title", description: "Recipient title prefix with period (e.g. Dr., Prof., Mr., Mrs., Ms.)" },
    { key: "firstName", description: "Recipient first name" },
    { key: "lastName", description: "Recipient last name" },
    { key: "eventName", description: "Event name" },
    { key: "subject", description: "Email subject" },
    { key: "message", description: "Custom message body (tokens typed inside it resolve too)" },
    { key: "organizerSignature", description: "Sender's personal email signature (HTML, from Profile → Email Signature) — also works typed inside the message" },
    { key: "honorarium", description: "Speaker sends only: the honorarium / speaker fee agreed by the organiser, e.g. USD 1,500.00 (0.00 when none is set); {{honorariumAmount}} and {{honorariumCurrency}} carry the parts" },
    { key: "rsvpLink", description: "The recipient's personal RSVP link: in a bulk send, for the RSVP chosen in the send dialog (people not on its guest list are skipped); in a per-person send, the one open RSVP that person is invited to. Also works typed inside the message; {{rsvpName}} carries the RSVP's name" },
    { key: "rsvpButton", description: "The same personal RSVP link rendered as a ready-made \"RSVP now\" button with a personal-link note under it; drop it in wherever you would put the link" },
    { key: "ctaText", description: "Call-to-action button text" },
    { key: "ctaLink", description: "Call-to-action button URL" },
    ],
    rawHtmlKeys: [],
  },
  "payment-confirmation": {
    slug: "payment-confirmation",
    name: "Payment Confirmation",
    description: "Sent when a payment is received, with the invoice and receipt attached",
    recipient: "registration",
    surfaces: ["automatic"],
    variables: [
    { key: "title", description: "Attendee title prefix with period (e.g. Dr., Prof., Mr., Mrs., Ms.)" },
    { key: "firstName", description: "Attendee first name" },
    { key: "lastName", description: "Attendee last name" },
    { key: "eventName", description: "Event name" },
    { key: "eventDate", description: "Event date (formatted)" },
    { key: "eventVenue", description: "Event venue" },
    { key: "eventCity", description: "Event city" },
    { key: "eventCountry", description: "Event country" },
    { key: "registrationId", description: "Confirmation number" },
    { key: "ticketType", description: "Registration/ticket type" },
    { key: "amount", description: "Amount paid (e.g. USD 100.00)" },
    { key: "currency", description: "Currency code" },
    { key: "paymentDate", description: "Payment date (formatted)" },
    { key: "receiptUrl", description: "Stripe receipt URL (auto-generated)" },
    { key: "paymentReference", description: "The Stripe payment reference, for reconciliation" },
    { key: "receiptBlock", description: "The receipt link block (empty when Stripe returned no receipt)" },
    ],
    rawHtmlKeys: ["receiptBlock", "taxBlock"],
  },
  "refund-confirmation": {
    slug: "refund-confirmation",
    name: "Refund Confirmation",
    description: "Refund wording kept for events that hold a copy; no sender uses it since partial refunds shipped",
    recipient: "registration",
    surfaces: [],
    variables: [
    { key: "title", description: "Attendee title prefix with period (e.g. Dr., Prof., Mr., Mrs., Ms.)" },
    { key: "firstName", description: "Attendee first name" },
    { key: "lastName", description: "Attendee last name" },
    { key: "eventName", description: "Event name" },
    { key: "eventDate", description: "Event date (formatted)" },
    { key: "registrationId", description: "Confirmation number" },
    { key: "ticketType", description: "Registration/ticket type" },
    { key: "amount", description: "Amount refunded (e.g. USD 100.00)" },
    { key: "refundDate", description: "Refund date (formatted)" },
    ],
    rawHtmlKeys: [],
  },
  "payment-reminder": {
    slug: "payment-reminder",
    name: "Payment Reminder",
    description: "Chase an outstanding balance with the amount due and a Pay Now button",
    recipient: "registration",
    surfaces: ["registration", "bulk"],
    bulk: { type: "payment-reminder", label: "Payment Reminder", description: "Chase an outstanding balance with a Pay Now link", audiences: [{ audience: "registrations", order: 2 }] },
    single: [{ surface: "registration", type: "payment-reminder", label: "Payment Reminder" }],
    variables: [
    { key: "title", description: "Attendee title prefix with period (e.g. Dr., Prof., Mr., Mrs., Ms.)" },
    { key: "firstName", description: "Attendee first name" },
    { key: "lastName", description: "Attendee last name" },
    { key: "eventName", description: "Event name" },
    { key: "eventDate", description: "Event date (formatted)" },
    { key: "eventVenue", description: "Event venue" },
    { key: "eventCity", description: "Event city" },
    { key: "eventCountry", description: "Event country" },
    { key: "ticketType", description: "Registration/ticket type" },
    { key: "amount", description: "Amount due (e.g. USD 100.00)" },
    { key: "paymentBlock", description: "Pay Now button (auto-generated)" },
    { key: "entryBarcode", description: "Attendee entry barcode image — in-person registrations only (omit to exclude it)" },
    { key: "organizerSignature", description: "Sender's personal email signature (HTML, from Profile → Email Signature) — empty on automated sends" },
    ],
    rawHtmlKeys: ["paymentBlock"],
  },
  "webinar-confirmation": {
    slug: "webinar-confirmation",
    name: "Webinar Registration Confirmation",
    description: "Sent when someone registers for a webinar, with the join link and a calendar invite",
    recipient: "registration",
    surfaces: ["automatic"],
    bulk: { type: "webinar-confirmation", label: "Webinar Confirmation", description: "Join link and calendar invite", audiences: [] },
    variables: [
    { key: "title", description: "Registrant title, e.g. Dr. (empty when none is recorded)" },
    { key: "firstName", description: "Registrant first name" },
    { key: "lastName", description: "Registrant last name" },
    { key: "registrationId", description: "Registration number (e.g. 007)" },
    { key: "ticketType", description: "Registration type name" },
    { key: "webinarDate", description: "Webinar date in the event's timezone" },
    { key: "webinarTime", description: "Webinar start time in the event's timezone" },
    { key: "joinUrl", description: "Link to the gated session page where the attendee joins" },
    { key: "passcodeBlock", description: "The Zoom passcode line (empty when the webinar has none)" },
    { key: "calendarBlock", description: "Add-to-calendar links for Google and Outlook" },
    { key: "organizerSignature", description: "The sender's email signature (empty on the automatic send)" },
    ],
    rawHtmlKeys: ["passcodeBlock", "calendarBlock"],
  },
  "webinar-reminder-24h": {
    slug: "webinar-reminder-24h",
    name: "Webinar Reminder — 24 hours",
    description: "Sent by the webinar sequence a day before",
    recipient: "registration",
    surfaces: ["automatic"],
    bulk: { type: "webinar-reminder-24h", label: "Webinar Reminder (24h)", description: "A day before the webinar", audiences: [] },
    variables: [
    { key: "title", description: "Registrant title, e.g. Dr. (empty when none is recorded)" },
    { key: "firstName", description: "Registrant first name" },
    { key: "lastName", description: "Registrant last name" },
    { key: "webinarDate", description: "Webinar date in the event's timezone" },
    { key: "webinarTime", description: "Webinar start time in the event's timezone" },
    { key: "joinUrl", description: "Link to the gated session page where the attendee joins" },
    { key: "passcodeBlock", description: "The Zoom passcode line (empty when the webinar has none)" },
    { key: "organizerSignature", description: "The sender's email signature (empty on the automatic send)" },
    ],
    rawHtmlKeys: ["passcodeBlock"],
  },
  "webinar-reminder-1h": {
    slug: "webinar-reminder-1h",
    name: "Webinar Reminder — 1 hour",
    description: "Sent by the webinar sequence an hour before",
    recipient: "registration",
    surfaces: ["automatic"],
    bulk: { type: "webinar-reminder-1h", label: "Webinar Reminder (1h)", description: "An hour before the webinar", audiences: [] },
    variables: [
    { key: "title", description: "Registrant title, e.g. Dr. (empty when none is recorded)" },
    { key: "firstName", description: "Registrant first name" },
    { key: "lastName", description: "Registrant last name" },
    { key: "webinarDate", description: "Webinar date in the event's timezone" },
    { key: "webinarTime", description: "Webinar start time in the event's timezone" },
    { key: "joinUrl", description: "Link to the gated session page where the attendee joins" },
    { key: "passcodeBlock", description: "The Zoom passcode line (empty when the webinar has none)" },
    { key: "organizerSignature", description: "The sender's email signature (empty on the automatic send)" },
    ],
    rawHtmlKeys: ["passcodeBlock"],
  },
  "webinar-live-now": {
    slug: "webinar-live-now",
    name: "Webinar Live Now",
    description: "Sent by the webinar sequence when the webinar starts",
    recipient: "registration",
    surfaces: ["automatic"],
    bulk: { type: "webinar-live-now", label: "Webinar Live Now", description: "When the webinar starts", audiences: [] },
    variables: [
    { key: "title", description: "Registrant title, e.g. Dr. (empty when none is recorded)" },
    { key: "firstName", description: "Registrant first name" },
    { key: "lastName", description: "Registrant last name" },
    { key: "webinarDate", description: "Webinar date in the event's timezone" },
    { key: "webinarTime", description: "Webinar start time in the event's timezone" },
    { key: "joinUrl", description: "Link to the gated session page where the attendee joins" },
    { key: "passcodeBlock", description: "The Zoom passcode line (empty when the webinar has none)" },
    { key: "organizerSignature", description: "The sender's email signature (empty on the automatic send)" },
    ],
    rawHtmlKeys: ["passcodeBlock"],
  },
  "webinar-thank-you": {
    slug: "webinar-thank-you",
    name: "Webinar Thank You",
    description: "Sent by the webinar sequence after the webinar, with the replay when it is ready",
    recipient: "registration",
    surfaces: ["automatic"],
    bulk: { type: "webinar-thank-you", label: "Webinar Thank You", description: "After the webinar", audiences: [] },
    variables: [
    { key: "title", description: "Registrant title, e.g. Dr. (empty when none is recorded)" },
    { key: "firstName", description: "Registrant first name" },
    { key: "lastName", description: "Registrant last name" },
    { key: "recordingBlock", description: "The Watch Replay button once the recording is available (empty before)" },
    { key: "organizerSignature", description: "The sender's email signature (empty on the automatic send)" },
    ],
    rawHtmlKeys: ["recordingBlock"],
  },
  "webinar-panelist-invitation": {
    slug: "webinar-panelist-invitation",
    name: "Webinar Panelist Invitation",
    description: "Sent to a panelist added to the webinar, with their own join link",
    recipient: "speaker",
    surfaces: ["console"],
    variables: [
    { key: "panelistName", description: "Panelist full name" },
    { key: "sessionName", description: "The webinar session name" },
    { key: "sessionStart", description: "The session start, in the event's timezone" },
    { key: "joinUrl", description: "The panelist's own Zoom join link" },
    { key: "organizerSignature", description: "The sender's email signature (from their Profile)" },
    ],
    rawHtmlKeys: [],
  },
  "survey-invitation": {
    slug: "survey-invitation",
    name: "Survey Invitation",
    description: "Sent with each person's personal survey link",
    recipient: "registration",
    surfaces: ["registration", "bulk"],
    bulk: { type: "survey-invitation", label: "Survey Invitation", description: "Send a unique link to the post-event feedback survey", audiences: [{ audience: "registrations", order: 3 }] },
    single: [{ surface: "registration", type: "survey-invitation", label: "Survey Invitation" }],
    variables: [
    { key: "title", description: "Registrant title, e.g. Dr. (empty when none is recorded)" },
    { key: "firstName", description: "Registrant first name" },
    { key: "lastName", description: "Registrant last name" },
    { key: "registrationId", description: "Registration number (e.g. 007)" },
    { key: "ticketType", description: "Registration type name" },
    { key: "personalMessage", description: "The message typed in the send dialog (optional)" },
    { key: "surveyLink", description: "The person's own single-use survey link, created at send time" },
    { key: "organizerName", description: "The sender's name" },
    { key: "organizerSignature", description: "The sender's email signature (from their Profile)" },
    ],
    rawHtmlKeys: [],
  },
  "survey-thankyou": {
    slug: "survey-thankyou",
    name: "Survey Thank You",
    description: "Sent after a survey is answered; carries a certificate issued on it",
    recipient: "registration",
    surfaces: ["automatic"],
    variables: [
    { key: "title", description: "Registrant title, e.g. Dr. (empty when none is recorded)" },
    { key: "firstName", description: "Registrant first name" },
    { key: "lastName", description: "Registrant last name" },
    { key: "registrationId", description: "Registration number (e.g. 007)" },
    { key: "ticketType", description: "Registration type name" },
    { key: "organizerSignature", description: "The sender's email signature (empty on the automatic send)" },
    ],
    rawHtmlKeys: [],
  },
  "certificate-attendance-delivery": {
    slug: "certificate-attendance-delivery",
    name: CERT_COVER_TEMPLATE_NAMES.ATTENDANCE,
    description: "Cover email for one attendance certificate",
    recipient: "registration",
    surfaces: ["certificates"],
    variables: [
    { key: "recipientName", description: "Recipient full name with title (e.g. Dr. Jane Doe)" },
    { key: "title", description: "Recipient title only, e.g. Dr. (empty when none is recorded)" },
    { key: "firstName", description: "Recipient first name" },
    { key: "lastName", description: "Recipient last name" },
    { key: "eventName", description: "Event name" },
    { key: "eventDateRange", description: "Event date range (e.g. 17th - 19th June 2026)" },
    { key: "eventDate", description: "Event start date (formatted)" },
    { key: "eventVenue", description: "Event venue" },
    { key: "venueLine", description: "\"at Venue, City, Country\" line (empty when no venue)" },
    { key: "organizationName", description: "Organization name" },
    { key: "certificateType", description: "Certificate of Attendance" },
    { key: "certificateSerial", description: "The certificate's serial number" },
    { key: "certificateList", description: "One line with the certificate label and serial" },
    ],
    rawHtmlKeys: [],
  },
  "certificate-appreciation-delivery": {
    slug: "certificate-appreciation-delivery",
    name: CERT_COVER_TEMPLATE_NAMES.APPRECIATION,
    description: "Cover email for one appreciation certificate",
    recipient: "speaker",
    surfaces: ["certificates"],
    variables: [
    { key: "recipientName", description: "Recipient full name with title (e.g. Dr. Jane Doe)" },
    { key: "title", description: "Recipient title only, e.g. Dr. (empty when none is recorded)" },
    { key: "firstName", description: "Recipient first name" },
    { key: "lastName", description: "Recipient last name" },
    { key: "eventName", description: "Event name" },
    { key: "eventDateRange", description: "Event date range (e.g. 17th - 19th June 2026)" },
    { key: "eventDate", description: "Event start date (formatted)" },
    { key: "eventVenue", description: "Event venue" },
    { key: "venueLine", description: "\"at Venue, City, Country\" line (empty when no venue)" },
    { key: "organizationName", description: "Organization name" },
    { key: "certificateType", description: "Certificate of Appreciation" },
    { key: "certificateSerial", description: "The certificate's serial number" },
    { key: "certificateList", description: "One line with the certificate label and serial" },
    { key: "abstractTitle", description: "The speaker's accepted abstract title (poster preferred); empty when none" },
    ],
    rawHtmlKeys: [],
  },
  "certificate-bundle-delivery": {
    slug: "certificate-bundle-delivery",
    name: CERT_BUNDLE_COVER_TEMPLATE_NAME,
    description: "Cover email for several certificates in one email",
    recipient: "any",
    surfaces: ["certificates"],
    variables: [
    { key: "recipientName", description: "Recipient full name with title (e.g. Dr. Jane Doe)" },
    { key: "title", description: "Recipient title only, e.g. Dr. (empty when none is recorded)" },
    { key: "firstName", description: "Recipient first name" },
    { key: "lastName", description: "Recipient last name" },
    { key: "eventName", description: "Event name" },
    { key: "eventDateRange", description: "Event date range (e.g. 17th - 19th June 2026)" },
    { key: "eventDate", description: "Event start date (formatted)" },
    { key: "eventVenue", description: "Event venue" },
    { key: "eventCity", description: "Event city" },
    { key: "eventCountry", description: "Event country" },
    { key: "venueLine", description: "\"at Venue, City, Country\" line (empty when no venue)" },
    { key: "organizationName", description: "Organization name" },
    { key: "certificateList", description: "One line per attached certificate: label + serial" },
    { key: "certificateSerial", description: "Comma-joined serials of the attached certificates" },
    { key: "certificateType", description: "Certificate type label(s), e.g. Certificate of Attendance" },
    ],
    rawHtmlKeys: [],
  },
  "document-delivery": {
    slug: "document-delivery",
    name: "Document Delivery (Invoice / Receipt / Credit Note)",
    description: "Sent when an invoice, receipt or credit note is resent",
    recipient: "registration",
    surfaces: ["automatic"],
    variables: [
    { key: "firstName", description: "Attendee first name" },
    { key: "lastName", description: "Attendee last name" },
    { key: "documentType", description: "Document label: Invoice, Payment Receipt, or Credit Note" },
    { key: "documentTypeLower", description: "Lower-case document label (e.g. credit note) for mid-sentence use" },
    { key: "documentNumber", description: "Document number (e.g. HFC2026-CN-001)" },
    { key: "eventName", description: "Event name" },
    ],
    rawHtmlKeys: [],
  },
  "dinner-rsvp-invitation": {
    slug: "dinner-rsvp-invitation",
    name: "Dinner RSVP Invitation",
    description: "Sent from the RSVP console with each person's personal RSVP link",
    recipient: "any",
    surfaces: ["console"],
    variables: [
    { key: "firstName", description: "Invitee first name" },
    { key: "lastName", description: "Invitee last name" },
    { key: "fullName", description: "Invitee full name (as entered)" },
    { key: "email", description: "Invitee email address" },
    { key: "eventName", description: "Event name" },
    { key: "rsvpName", description: "This RSVP's name, e.g. \"Gala Dinner\" or \"Pre-conference Workshops\"" },
    { key: "itemWord", description: "\"session\" or \"sessions\" — a neutral word for RSVPs that are not dinners" },
    { key: "dinnerWord", description: "\"dinner\" or \"dinners\" — LEGACY, reads wrong on a workshop RSVP; prefer {{rsvpName}}" },
    { key: "rsvpLink", description: "The invitee's personalized RSVP link (unique per recipient)" },
    { key: "rsvpButton", description: "That link as a ready-made \"RSVP now\" button with a personal-link note under it" },
    { key: "personalMessage", description: "Optional note typed by the organizer at send time" },
    { key: "organizerName", description: "Organizing team / organization name" },
    { key: "organizerSignature", description: "The sending user's email signature (from their profile)" },
    ],
    rawHtmlKeys: [],
  },
  "travel-grant-invitation": {
    slug: "travel-grant-invitation",
    name: "Travel Grant Invitation",
    description: "Sent from the travel-grant console to an eligible overseas author",
    recipient: "speaker",
    surfaces: ["console"],
    variables: [
    { key: "speakerName", description: "Author name, with title prefix" },
    { key: "firstName", description: "Author first name" },
    { key: "lastName", description: "Author last name" },
    { key: "eventName", description: "Event name" },
    {
      key: "travelGrantBlock",
      description:
        "The travel-grant message + CTA button. Same block the submission-confirmation email uses, so the two cannot drift. Renders as nothing for an author who is not eligible.",
    },
    { key: "travelGrantBlockText", description: "Plain-text version of the block" },
    { key: "personalMessage", description: "Your optional note, typed in the send dialog" },
    { key: "organizerName", description: "Name of the sender" },
    { key: "organizerSignature", description: "Sender's saved email signature" },
    ],
    rawHtmlKeys: [],
  },
  "speaker-reimbursement-invitation": {
    slug: "speaker-reimbursement-invitation",
    name: "Speaker Reimbursement Form",
    description: "Sent from the reimbursement console with the speaker's private form link",
    recipient: "speaker",
    surfaces: ["console"],
    variables: [
    { key: "firstName", description: "Speaker first name" },
    { key: "lastName", description: "Speaker last name" },
    { key: "speakerName", description: "Speaker full name with title prefix (e.g. Dr. Jane Doe)" },
    { key: "email", description: "Speaker email address" },
    { key: "eventName", description: "Event name" },
    { key: "reimbursementLink", description: "The speaker's personalized reimbursement-form link (unique per recipient)" },
    { key: "honorarium", description: "Honorarium / speaker fee agreed by the organiser, e.g. USD 1,500.00 (0.00 when none is set); {{honorariumAmount}} and {{honorariumCurrency}} carry the parts" },
    { key: "personalMessage", description: "Optional note typed by the organizer at send time" },
    { key: "organizerName", description: "Organizing team / organization name" },
    { key: "organizerSignature", description: "The sending user's email signature (from their profile)" },
    ],
    rawHtmlKeys: [],
  },
  "speaker-profile-form-request": {
    slug: "speaker-profile-form-request",
    name: "Speaker Profile Form Request",
    description: "Sent from the speaker page with the speaker's private profile form link",
    recipient: "speaker",
    surfaces: ["console"],
    variables: [
    { key: "firstName", description: "Speaker first name" },
    { key: "lastName", description: "Speaker last name" },
    { key: "speakerName", description: "Speaker full name with title prefix (e.g. Dr. Jane Doe)" },
    { key: "email", description: "Speaker email address" },
    { key: "eventName", description: "Event name" },
    { key: "profileFormLink", description: "The speaker's personalized photo & documents form link (unique per recipient)" },
    { key: "honorarium", description: "Honorarium / speaker fee agreed by the organiser, e.g. USD 1,500.00 (0.00 when none is set); {{honorariumAmount}} and {{honorariumCurrency}} carry the parts" },
    { key: "personalMessage", description: "Optional note typed by the organizer at send time" },
    { key: "organizerName", description: "Organizing team / organization name" },
    { key: "organizerSignature", description: "The sending user's email signature (from their profile)" },
    ],
    rawHtmlKeys: [],
  },
  "speaker-reimbursement-received": {
    slug: "speaker-reimbursement-received",
    name: "Reimbursement Form Received",
    description: "Sent to the speaker when their reimbursement form is submitted",
    recipient: "speaker",
    surfaces: ["automatic"],
    variables: [
    { key: "firstName", description: "Speaker first name" },
    { key: "speakerName", description: "Full name as submitted on the form" },
    { key: "eventName", description: "Event name" },
    { key: "claimSummary", description: "HTML table of the claimed items + per-currency totals" },
    { key: "claimSummaryText", description: "Plain-text list of the claimed items" },
    { key: "honorarium", description: "The honorarium / speaker fee the organiser agreed (also the first line of the claim table), e.g. USD 1,500.00; 0.00 when none" },
    { key: "organizerName", description: "Organizing team / organization name" },
    ],
    rawHtmlKeys: ["claimSummary"],
  },
};

/**
 * The event block every email gets, whatever its slug (Aug 27, 2026). Lives
 * here rather than in email.ts so a client component can read it; email.ts
 * re-exports it under the same name.
 */
export const GLOBAL_EVENT_VARIABLES: ReadonlyArray<TemplateVariable> = [
  { key: "eventName", description: "Event name" },
  { key: "eventDate", description: "Event start date, in the event's timezone (e.g. Friday, January 15, 2027)" },
  { key: "eventDateRange", description: "Event dates, collapsed on a single-day event (e.g. January 15 - 17, 2027)" },
  { key: "eventVenue", description: "Venue and city (e.g. Raffles Hotel, Dubai)" },
];

/**
 * What `executeBulkEmail` puts in `vars` for EVERY recipient of EVERY bulk
 * send, before the per-type overrides. A bulk-surface template may therefore
 * use any of these even when its own `variables` list does not advertise it,
 * and a CUSTOM template (which has no registry entry and is only sendable
 * through bulk) gets exactly this set plus the global event block.
 *
 * Pinned to the real object by `email-template-token-check.test.ts`, which
 * reads bulk-email.ts and fails if a key here stops being set there. Keep the
 * two in step: dropping one silently turns a working organiser template into
 * a refused send.
 */
export const BULK_BASE_VARIABLES: readonly string[] = [
  "title", "firstName", "lastName", "speakerName",
  "eventName", "eventDate", "eventVenue", "eventCity", "eventCountry", "eventAddress",
  "organizerName", "organizerEmail", "organizerSignature",
  "personalMessage", "ticketType", "registrationId", "daysUntilEvent",
  "presentationDetails", "presentationDetailsText",
  "moderatorDetails", "moderatorDetailsText", "sessionDetails",
  "agreementLink", "agreementBlock", "agreementBlockText", "agreementAttachment",
  "entryBarcode", "entryBarcodeText", "paymentBlock",
];

/**
 * Bulk tokens filled only when the sender picks an RSVP in the send dialog.
 * Using one without choosing an RSVP is refused at enqueue with a message
 * naming the fix, so it is a legitimate thing to write into a template and
 * must not be reported as unfillable.
 */
export const BULK_CONDITIONAL_VARIABLES: readonly string[] = ["rsvpLink", "rsvpName", "rsvpButton"];

/**
 * Bulk tokens filled only when the audience is speakers (`bulk-email.ts`, the
 * speaker-context branch; since Sep 3, 2026). Missing from every list until
 * Sep 25, 2026, so a custom template using them was flagged as having unknown
 * tokens and the agent's create refused them, although a send to speakers
 * fills them. Sent to another audience they stay unfilled, and the send's
 * unresolved-token guard says so, as it does for an RSVP token with no RSVP.
 */
export const BULK_SPEAKER_VARIABLES: readonly string[] = ["honorarium", "honorariumAmount", "honorariumCurrency"];

/**
 * Every token key a template's senders can fill, for the save-time check that
 * warns an organiser before a send is refused.
 *
 * Why this exists: on Sep 18, 2026 an organiser put `{{certificateList}}`, a
 * certificate-cover token, into a Survey Thank You. The thank-you sender fills
 * six variables and not that one, so every thank-you on a live event was
 * refused for 100 minutes. Preview did not catch it, because preview supplies
 * a sample value for that token on every template and rendered it perfectly.
 *
 * A `*Text` mirror of an allowed block token is allowed too: the plain-text
 * part is filled beside the HTML one and is deliberately not advertised.
 *
 * An unknown slug is a custom template, which is only sendable through bulk.
 */
export function templateAllowedTokenKeys(slug: string): string[] {
  const allowed = new Set<string>(GLOBAL_EVENT_VARIABLES.map((v) => v.key));
  const spec = isSystemTemplateSlug(slug) ? EMAIL_TEMPLATE_REGISTRY[slug] : null;
  if (spec) {
    for (const v of spec.variables) allowed.add(v.key);
    for (const k of spec.rawHtmlKeys) allowed.add(k);
  }
  if (!spec || spec.surfaces.includes("bulk")) {
    for (const k of BULK_BASE_VARIABLES) allowed.add(k);
    for (const k of BULK_CONDITIONAL_VARIABLES) allowed.add(k);
    for (const k of BULK_SPEAKER_VARIABLES) allowed.add(k);
  }
  for (const k of [...allowed]) allowed.add(`${k}Text`);
  return [...allowed];
}

/** The specs in seed order. */
export const EMAIL_TEMPLATE_SPECS: readonly EmailTemplateSpec[] = SYSTEM_TEMPLATE_SLUG_LIST.map((s) => EMAIL_TEMPLATE_REGISTRY[s]);

/** True for a system slug (compile-time list, runtime check for a string). */
export function isSystemTemplateSlug(slug: string): slug is SystemTemplateSlug {
  return Object.prototype.hasOwnProperty.call(EMAIL_TEMPLATE_REGISTRY, slug);
}

/** The templates the Event Settings tab lists (the most-used ones). */
export const CORE_TEMPLATE_SLUGS: ReadonlySet<string> = new Set(
  EMAIL_TEMPLATE_SPECS.filter((t) => t.core).map((t) => t.slug),
);

/** The one-line description for the templates list; the slug itself for a custom template. */
export function templateDescription(slug: string): string {
  return isSystemTemplateSlug(slug) ? EMAIL_TEMPLATE_REGISTRY[slug].description : slug;
}

/**
 * The slug a single-send `type` renders on one surface, or null. The speaker
 * page and sheet use it for previews too, so a `previewOnly` entry counts here.
 */
export function singleSendSlugFor(surface: SingleSendSpec["surface"], type: string): string | null {
  for (const t of EMAIL_TEMPLATE_SPECS) {
    if (t.single?.some((s) => s.surface === surface && s.type === type)) return t.slug;
  }
  return null;
}

/** The single-send entries for a surface, in registry order; `route` drops preview-only ones. */
export function singleSendTypesFor(surface: SingleSendSpec["surface"], opts: { route?: boolean } = {}): SingleSendSpec[] {
  const out: SingleSendSpec[] = [];
  for (const t of EMAIL_TEMPLATE_SPECS) {
    for (const s of t.single ?? []) {
      if (s.surface !== surface) continue;
      if (opts.route && s.previewOnly) continue;
      out.push(s);
    }
  }
  return out;
}

/** type → slug for the bulk pipeline: the FIRST template carrying each type, in seed order. */
export const BULK_EMAIL_TEMPLATE_SLUGS: Readonly<Record<string, string>> = (() => {
  const map: Record<string, string> = {};
  for (const t of EMAIL_TEMPLATE_SPECS) {
    if (t.bulk && !(t.bulk.type in map)) map[t.bulk.type] = t.slug;
  }
  return map;
})();

/**
 * The slug for (type, audience): the template carrying that type for that
 * audience (a reviewer "invitation" is the reviewer pool invitation), else the
 * type's first template for any audience, else null.
 */
export function bulkTemplateSlugFor(emailType: string, recipientType: string): string | null {
  for (const t of EMAIL_TEMPLATE_SPECS) {
    if (t.bulk?.type === emailType && t.bulk.audiences.some((a) => a.audience === recipientType)) return t.slug;
  }
  return BULK_EMAIL_TEMPLATE_SLUGS[emailType] ?? null;
}

export interface BulkEmailTypeOption {
  value: string;
  label: string;
  description: string;
}

/**
 * Bulk options that are not templates: the certificate pipeline issues and
 * attaches PDFs with its own cover emails, but is picked from the same list.
 */
export const EXTRA_BULK_EMAIL_OPTIONS: ReadonlyArray<BulkEmailTypeOption & { audiences: readonly BulkAudienceEntry[] }> = [
  {
    value: "certificate",
    label: "Certificates",
    description: "Issue & attach certificate PDFs (tag-matched, one email per person)",
    audiences: [{ audience: "speakers", order: 2 }, { audience: "registrations", order: 4 }],
  },
];

/** The email-type dropdown for one Communications audience, in its display order. */
export function bulkEmailTypeOptionsFor(audience: BulkEmailAudience): BulkEmailTypeOption[] {
  const rows: Array<{ order: number; option: BulkEmailTypeOption }> = [];
  for (const t of EMAIL_TEMPLATE_SPECS) {
    const entry = t.bulk?.audiences.find((a) => a.audience === audience);
    if (!t.bulk || !entry) continue;
    rows.push({ order: entry.order, option: { value: t.bulk.type, label: t.bulk.label, description: entry.description ?? t.bulk.description } });
  }
  for (const x of EXTRA_BULK_EMAIL_OPTIONS) {
    const entry = x.audiences.find((a) => a.audience === audience);
    if (!entry) continue;
    rows.push({ order: entry.order, option: { value: x.value, label: x.label, description: x.description } });
  }
  return rows.sort((a, b) => a.order - b.order).map((r) => r.option);
}
