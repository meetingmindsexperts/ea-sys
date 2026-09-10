import type { PresentationType } from "@prisma/client";
import { PRESENTATION_TYPE_LABELS } from "@/app/(dashboard)/events/[eventId]/abstracts/abstract-enums";
import { normalizeCoAuthors } from "@/lib/abstract-coauthors";
import { formatAbstractSerial } from "@/lib/abstract-serial";
import type { DocxEntry } from "@/lib/docx-export";
import { formatSessionProposalSerial } from "@/lib/session-proposal-serial";
import { formatSessionType } from "@/lib/session-enums";
import { formatPersonName } from "@/lib/utils";

/**
 * Row → Word-entry mappers for the two submission exports (September 10, 2026,
 * organiser request: "export all abstracts into a Word document, and session
 * proposals into a Word document").
 *
 * These own the field ORDER and the drop-empty rule; the layout itself lives in
 * [docx-export.ts](./docx-export.ts). Keeping the two apart is what stops the
 * abstracts document and the proposals document drifting into two hand-built
 * layouts, and it lets the mapping be tested without a request or a database.
 *
 * The label under the author line differs on purpose (owner: "show what is
 * relevant to what"): an abstract has a presenting author and a presentation
 * type, a session proposal has a proposer, a duration and a format.
 */

/** The person shape both mappers read. Structural, so a Prisma row satisfies it. */
export interface DocxSpeakerLike {
  title: string | null;
  firstName: string;
  lastName: string;
  organization: string | null;
  country: string | null;
}

export interface AbstractDocxRow {
  serialId: number | null;
  title: string;
  content: string;
  presentationType: string | null;
  coAuthors: unknown;
  theme: { name: string } | null;
  subTheme: { name: string } | null;
  speaker: DocxSpeakerLike | null;
}

export interface ProposalDocxRow {
  serialId: number | null;
  title: string;
  description: string;
  durationMinutes: number | null;
  proposedFormat: string | null;
  theme: { name: string } | null;
  speaker: DocxSpeakerLike;
}

/** "Dr Amal Haddad, Tawam Hospital, United Arab Emirates" — affiliation only when set. */
function personLine(speaker: DocxSpeakerLike | null): string {
  if (!speaker) return "";
  const name = formatPersonName(speaker.title, speaker.firstName, speaker.lastName);
  return [name, speaker.organization, speaker.country].filter(Boolean).join(", ");
}

/**
 * "Sara Khan, Cleveland Clinic, UAE; Omar Ali, KAUST, Saudi Arabia".
 *
 * Co-authors carry no title field (unlike the presenting author), so they read
 * as a bare name plus whatever affiliation was supplied.
 */
export function coAuthorsLine(raw: unknown): string {
  return normalizeCoAuthors(raw)
    .map((c) =>
      [[c.firstName, c.lastName].filter(Boolean).join(" "), c.organization, c.country]
        .filter(Boolean)
        .join(", "),
    )
    .filter((entry) => entry.length > 0)
    .join("; ");
}

/** "Cardiology › Heart failure" when a sub-theme is set, else the theme alone. */
function themeLine(theme: { name: string } | null, subTheme?: { name: string } | null): string {
  if (!theme) return "";
  return subTheme ? `${theme.name} › ${subTheme.name}` : theme.name;
}

function durationLine(minutes: number | null): string {
  if (minutes == null) return "";
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

function presentationTypeLine(type: string | null): string {
  if (!type) return "";
  return PRESENTATION_TYPE_LABELS[type as PresentationType] ?? type;
}

export function abstractToDocxEntry(row: AbstractDocxRow): DocxEntry {
  return {
    heading: `${formatAbstractSerial(row.serialId)}  ${row.title}`,
    fields: [
      { label: "Theme", value: themeLine(row.theme, row.subTheme) },
      { label: "Presenting Author", value: personLine(row.speaker) },
      { label: "Co-authors", value: coAuthorsLine(row.coAuthors) },
      { label: "Presentation Type", value: presentationTypeLine(row.presentationType) },
    ],
    body: row.content,
  };
}

export function proposalToDocxEntry(row: ProposalDocxRow): DocxEntry {
  return {
    heading: `${formatSessionProposalSerial(row.serialId)}  ${row.title}`,
    fields: [
      { label: "Theme", value: themeLine(row.theme) },
      { label: "Proposer", value: personLine(row.speaker) },
      { label: "Duration", value: durationLine(row.durationMinutes) },
      // A proposal need not state a format; when it does, it is a program kind
      // (Session / Workshop / Symposium) rendered through the shared label map.
      { label: "Format", value: row.proposedFormat ? formatSessionType(row.proposedFormat) : "" },
    ],
    body: row.description,
  };
}

/** "14 abstracts · Exported 10 September 2026" — the muted line under the title. */
export function exportSubtitle(count: number, noun: string, now: Date): string {
  const plural = count === 1 ? noun : `${noun}s`;
  const date = now.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  return `${count} ${plural} · Exported ${date}`;
}
