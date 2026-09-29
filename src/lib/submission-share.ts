/**
 * Shared submission views (Sep 29, 2026; docs/SUBMISSION_SHARE_PLAN.md): the
 * ONE place the rules live. The organiser dialog reads the catalogue to draw
 * its checkboxes, the save route validates against it, and the public route
 * projects every row through it. Pure: no database, no Node imports, so the
 * client bundle can use it.
 *
 * The guarantee that matters: a field the organiser has not switched on is
 * ABSENT from what the public route returns (not blanked), and the contact
 * columns are not even selected from the database unless switched on. Number
 * and title are always shown; reviewer data is not in the catalogue at all,
 * so no configuration can publish it.
 */
import { formatAbstractSerial } from "@/lib/abstract-serial";
import { normalizeCoAuthors } from "@/lib/abstract-coauthors";
import { formatSessionProposalSerial } from "@/lib/session-proposal-serial";
import { formatSessionType } from "@/lib/session-enums";
import { formatPersonName } from "@/lib/utils";

export type ShareKind = "ABSTRACTS" | "SESSION_PROPOSALS";
export const SHARE_KINDS: ShareKind[] = ["ABSTRACTS", "SESSION_PROPOSALS"];

export type FieldGroup = "submission" | "people" | "contact";

export interface ShareField {
  key: string;
  label: string;
  group: FieldGroup;
  defaultOn: boolean;
}

const ABSTRACT_FIELDS: ShareField[] = [
  { key: "content", label: "Abstract text", group: "submission", defaultOn: true },
  { key: "theme", label: "Theme and sub-theme", group: "submission", defaultOn: true },
  { key: "track", label: "Track", group: "submission", defaultOn: true },
  { key: "presentationType", label: "Presentation type", group: "submission", defaultOn: true },
  { key: "specialty", label: "Specialty", group: "submission", defaultOn: true },
  { key: "status", label: "Status", group: "submission", defaultOn: false },
  { key: "submittedAt", label: "Submitted date", group: "submission", defaultOn: false },
  { key: "authorName", label: "Presenting author", group: "people", defaultOn: true },
  { key: "authorAffiliation", label: "Author organisation and job title", group: "people", defaultOn: true },
  { key: "authorCountry", label: "Author country", group: "people", defaultOn: true },
  { key: "coAuthors", label: "Co-authors (names and affiliations)", group: "people", defaultOn: true },
  { key: "authorEmail", label: "Author email", group: "contact", defaultOn: false },
  { key: "authorAdditionalEmail", label: "Author additional email", group: "contact", defaultOn: false },
  { key: "authorPhone", label: "Author phone", group: "contact", defaultOn: false },
];

const PROPOSAL_FIELDS: ShareField[] = [
  { key: "description", label: "Description", group: "submission", defaultOn: true },
  { key: "theme", label: "Theme", group: "submission", defaultOn: true },
  { key: "format", label: "Proposed format", group: "submission", defaultOn: true },
  { key: "duration", label: "Duration", group: "submission", defaultOn: true },
  { key: "status", label: "Status", group: "submission", defaultOn: false },
  { key: "submittedAt", label: "Submitted date", group: "submission", defaultOn: false },
  { key: "authorName", label: "Proposer", group: "people", defaultOn: true },
  { key: "authorAffiliation", label: "Proposer organisation and job title", group: "people", defaultOn: true },
  { key: "authorCountry", label: "Proposer country", group: "people", defaultOn: true },
  { key: "authorEmail", label: "Proposer email", group: "contact", defaultOn: false },
  { key: "authorAdditionalEmail", label: "Proposer additional email", group: "contact", defaultOn: false },
  { key: "authorPhone", label: "Proposer phone", group: "contact", defaultOn: false },
];

export const SHARE_FIELDS: Record<ShareKind, ShareField[]> = {
  ABSTRACTS: ABSTRACT_FIELDS,
  SESSION_PROPOSALS: PROPOSAL_FIELDS,
};

/**
 * Statuses a link may show. DRAFT (private work in progress) and WITHDRAWN
 * (the author pulled it) are deliberately absent, so no selection reaches them.
 */
export const SHAREABLE_STATUSES: Record<ShareKind, { value: string; label: string; defaultOn: boolean }[]> = {
  ABSTRACTS: [
    { value: "SUBMITTED", label: "Submitted", defaultOn: true },
    { value: "UNDER_REVIEW", label: "Under review", defaultOn: true },
    { value: "ACCEPTED", label: "Accepted", defaultOn: true },
    { value: "REVISION_REQUESTED", label: "Revision requested", defaultOn: true },
    { value: "REJECTED", label: "Rejected", defaultOn: false },
  ],
  SESSION_PROPOSALS: [{ value: "SUBMITTED", label: "Submitted", defaultOn: true }],
};

export const SHARE_KIND_LABEL: Record<ShareKind, string> = {
  ABSTRACTS: "Abstracts",
  SESSION_PROPOSALS: "Session proposals",
};

/** The public page's row ceiling; the page says so when it is reached. */
export const SHARE_ROW_CAP = 1000;

export function defaultShareConfig(kind: ShareKind): { statuses: string[]; fields: string[] } {
  return {
    statuses: SHAREABLE_STATUSES[kind].filter((s) => s.defaultOn).map((s) => s.value),
    fields: SHARE_FIELDS[kind].filter((f) => f.defaultOn).map((f) => f.key),
  };
}

/** Keys of the contact group for a kind (the ones that warrant a warning). */
export function contactFieldKeys(kind: ShareKind): string[] {
  return SHARE_FIELDS[kind].filter((f) => f.group === "contact").map((f) => f.key);
}

/**
 * Validate a requested configuration against the catalogue. Unknown keys are
 * REFUSED rather than dropped, so a typo in a client never silently narrows
 * or widens what is shown. Duplicates collapse.
 */
export function validateShareConfig(
  kind: ShareKind,
  input: { statuses: string[]; fields: string[] },
): { ok: true; statuses: string[]; fields: string[] } | { ok: false; code: "UNKNOWN_STATUS" | "UNKNOWN_FIELD" | "NO_STATUS"; message: string } {
  const allowedStatuses = new Set(SHAREABLE_STATUSES[kind].map((s) => s.value));
  const allowedFields = new Set(SHARE_FIELDS[kind].map((f) => f.key));
  const badStatus = input.statuses.find((s) => !allowedStatuses.has(s));
  if (badStatus) return { ok: false, code: "UNKNOWN_STATUS", message: `"${badStatus}" cannot be shown on a shared page.` };
  const badField = input.fields.find((f) => !allowedFields.has(f));
  if (badField) return { ok: false, code: "UNKNOWN_FIELD", message: `"${badField}" is not a field that can be shared.` };
  const statuses = [...new Set(input.statuses)];
  if (statuses.length === 0) return { ok: false, code: "NO_STATUS", message: "Choose at least one status to show." };
  return { ok: true, statuses, fields: [...new Set(input.fields)] };
}

/**
 * The statuses a stored link may actually query. Re-filtered at READ time too,
 * so a row written before a status left the catalogue (or edited by hand) can
 * never reach DRAFT or WITHDRAWN.
 */
export function effectiveStatuses(kind: ShareKind, stored: string[]): string[] {
  const allowed = new Set(SHAREABLE_STATUSES[kind].map((s) => s.value));
  return stored.filter((s) => allowed.has(s));
}

/** Only catalogue fields survive, for the same read-time reason. */
export function effectiveFields(kind: ShareKind, stored: string[]): Set<string> {
  const allowed = new Set(SHARE_FIELDS[kind].map((f) => f.key));
  return new Set(stored.filter((f) => allowed.has(f)));
}

// ── Projection ───────────────────────────────────────────────────────────────

interface PersonRow {
  title: string | null;
  firstName: string;
  lastName: string;
  organization: string | null;
  jobTitle: string | null;
  country: string | null;
  // Present only when the route selected them (a contact field is enabled).
  email?: string | null;
  additionalEmail?: string | null;
  phone?: string | null;
}

export interface AbstractShareRow {
  serialId: number | null;
  title: string;
  content: string;
  status: string;
  presentationType: string | null;
  specialty: string | null;
  coAuthors: unknown;
  submittedAt: Date;
  theme: { name: string } | null;
  subTheme: { name: string } | null;
  track: { name: string } | null;
  speaker: PersonRow;
}

export interface ProposalShareRow {
  serialId: number | null;
  title: string;
  description: string;
  status: string;
  proposedFormat: string | null;
  durationMinutes: number | null;
  submittedAt: Date | null;
  createdAt: Date;
  theme: { name: string } | null;
  speaker: PersonRow;
}

/** What the public page receives per row. Every key but number/title is optional. */
export interface SharedItem {
  number: string;
  title: string;
  body?: string;
  theme?: string | null;
  track?: string | null;
  presentationType?: string | null;
  specialty?: string | null;
  format?: string | null;
  duration?: string | null;
  status?: string;
  submittedAt?: string | null;
  authorName?: string;
  authorAffiliation?: string | null;
  authorCountry?: string | null;
  coAuthors?: string[];
  authorEmail?: string | null;
  authorAdditionalEmail?: string | null;
  authorPhone?: string | null;
}

const PRESENTATION_LABEL: Record<string, string> = {
  ORAL: "Oral",
  POSTER: "Poster",
  ORAL_POSTER: "Oral or poster",
  VIDEO: "Video",
  WORKSHOP: "Workshop",
};

function affiliation(p: PersonRow): string | null {
  const parts = [p.jobTitle, p.organization].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

/** People fields shared by both kinds; each written only when switched on. */
function projectPerson(out: SharedItem, p: PersonRow, on: Set<string>): void {
  if (on.has("authorName")) out.authorName = formatPersonName(p.title, p.firstName, p.lastName);
  if (on.has("authorAffiliation")) out.authorAffiliation = affiliation(p);
  if (on.has("authorCountry")) out.authorCountry = p.country;
  if (on.has("authorEmail")) out.authorEmail = p.email ?? null;
  if (on.has("authorAdditionalEmail")) out.authorAdditionalEmail = p.additionalEmail ?? null;
  if (on.has("authorPhone")) out.authorPhone = p.phone ?? null;
}

export function projectAbstract(row: AbstractShareRow, on: Set<string>): SharedItem {
  const out: SharedItem = { number: formatAbstractSerial(row.serialId), title: row.title };
  if (on.has("content")) out.body = row.content;
  if (on.has("theme")) out.theme = row.theme ? (row.subTheme ? `${row.theme.name} › ${row.subTheme.name}` : row.theme.name) : null;
  if (on.has("track")) out.track = row.track?.name ?? null;
  if (on.has("presentationType")) out.presentationType = row.presentationType ? (PRESENTATION_LABEL[row.presentationType] ?? row.presentationType) : null;
  if (on.has("specialty")) out.specialty = row.specialty;
  if (on.has("status")) out.status = row.status;
  if (on.has("submittedAt")) out.submittedAt = row.submittedAt.toISOString();
  projectPerson(out, row.speaker, on);
  if (on.has("coAuthors")) {
    out.coAuthors = normalizeCoAuthors(row.coAuthors).map((c) =>
      [[c.firstName, c.lastName].join(" "), c.organization, c.country].filter(Boolean).join(", "),
    );
  }
  return out;
}

export function projectProposal(row: ProposalShareRow, on: Set<string>): SharedItem {
  const out: SharedItem = { number: formatSessionProposalSerial(row.serialId), title: row.title };
  if (on.has("description")) out.body = row.description;
  if (on.has("theme")) out.theme = row.theme?.name ?? null;
  if (on.has("format")) out.format = row.proposedFormat ? formatSessionType(row.proposedFormat) : null;
  if (on.has("duration")) out.duration = row.durationMinutes == null ? null : `${row.durationMinutes} minutes`;
  if (on.has("status")) out.status = row.status;
  if (on.has("submittedAt")) out.submittedAt = (row.submittedAt ?? row.createdAt).toISOString();
  projectPerson(out, row.speaker, on);
  return out;
}

/**
 * The speaker select for the public query. The contact columns are named ONLY
 * when their field is on, so a hidden email is never read from the database.
 */
export function speakerSelect(on: Set<string>) {
  return {
    title: true,
    firstName: true,
    lastName: true,
    organization: true,
    jobTitle: true,
    country: true,
    ...(on.has("authorEmail") && { email: true }),
    ...(on.has("authorAdditionalEmail") && { additionalEmail: true }),
    ...(on.has("authorPhone") && { phone: true }),
  } as const;
}

/** Public URL path for a link (the caller prefixes the app origin). */
export function sharePath(slug: string, token: string): string {
  return `/e/${encodeURIComponent(slug)}/shared/${encodeURIComponent(token)}`;
}
