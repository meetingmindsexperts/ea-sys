/**
 * What a speaker screen says under "Registration Type" (owner report, Nov 12,
 * 2026, 4th GCC Hematology Hub: "reg type in registration and speakers are
 * not in sync").
 *
 * A speaker carries its own free-text `registrationType`, and the Speakers
 * screens offered it as a dropdown of the event's registration types. Picking
 * "Faculty" there changed that text and nothing else: the person's
 * registration kept its own type, which is the one that decides the Faculty
 * count, the price and whether confirming the speaker settles it. An organiser
 * used the dropdown three times to "fix" a speaker imported as Physician at
 * 150; all three stayed Physician, Unpaid.
 *
 * The rule, in this one place: a speaker who has a live registration shows
 * THAT registration's type, read-only. The speaker's own text is shown, and
 * edited, only while there is no live registration to read. Pure and
 * client-safe: the two speaker screens and the speakers export share it.
 *
 * The type is NAMED the way the Registrations page names it
 * (`displayRegistrationType`): for a Faculty registration that is the
 * person's recorded profession, when there is one. A second way of naming it
 * here would put the two pages out of step again (review of 4da1db66).
 */
import { SPEAKER_API_REGISTRATION_TYPE, displayRegistrationType } from "@/lib/faculty-filter";

export interface SpeakerLinkedRegistration {
  serialId?: number | null;
  status: string;
  paymentStatus?: string | null;
  ticketType?: { name: string; isFaculty?: boolean | null } | null;
  /** The registration's attendee: its `registrationType` is the profession shown for a Faculty registration. */
  attendee?: { registrationType?: string | null } | null;
}

export type SpeakerRegistrationTypeView =
  /** No live registration: the speaker's own text applies, and may be edited. */
  | { kind: "own"; typeName: string | null }
  | {
      kind: "registration";
      /** The registration's type as the Registrations page names it, or NO_TYPE_LABEL when it has none yet. */
      typeName: string;
      isFaculty: boolean;
      /** The Faculty type's own name, when `typeName` is the person's profession instead; else null. */
      facultyTypeName: string | null;
      /** "043", or null for a registration with no number. */
      serial: string | null;
      /** What an organiser should know about this type, or null. */
      note: string | null;
    };

export const NO_TYPE_LABEL = "No type yet";

const DELEGATE_TYPE_NOTE =
  "A delegate type: this person counts as a delegate, and setting the speaker to Confirmed does not change this registration's status or payment.";
const NO_TYPE_NOTE = "This registration has no type yet. Give it one on the registration.";

function words(value: string): string {
  return value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, " ");
}

/** A cancelled registration is not one the speaker stands on: Re-grant makes a new one. */
function isLive(reg: SpeakerLinkedRegistration | null | undefined): reg is SpeakerLinkedRegistration {
  return !!reg && reg.status !== "CANCELLED";
}

function noteFor(reg: SpeakerLinkedRegistration): string | null {
  if (!reg.ticketType) return NO_TYPE_NOTE;
  if (reg.ticketType.isFaculty) return null;
  const now = reg.paymentStatus ? ` It is ${words(reg.status)}, ${words(reg.paymentStatus)} now.` : "";
  return DELEGATE_TYPE_NOTE + now;
}

export function speakerRegistrationTypeView(
  ownType: string | null | undefined,
  registration: SpeakerLinkedRegistration | null | undefined,
): SpeakerRegistrationTypeView {
  if (!isLive(registration)) return { kind: "own", typeName: ownType?.trim() || null };
  const isFaculty = registration.ticketType?.isFaculty === true;
  const ownName = registration.ticketType?.name.trim() || null;
  const typeName = displayRegistrationType(
    { ticketTypeName: ownName, isFaculty, attendeeRegistrationType: registration.attendee?.registrationType },
    NO_TYPE_LABEL,
  );
  return {
    kind: "registration",
    typeName,
    isFaculty,
    facultyTypeName: isFaculty && ownName && ownName !== typeName ? ownName : null,
    serial: registration.serialId != null ? String(registration.serialId).padStart(3, "0") : null,
    note: noteFor(registration),
  };
}

/**
 * What the speakers API serves as `registrationType` (owner, Nov 12, 2026:
 * "check why ... reg type is PHYSICIAN instead of faculty, whereas they are
 * marked reg type as faculty in production ... in the api, when I fetch it").
 *
 * The API served the speaker's own text. For someone whose registration is on
 * a Faculty type that text could say anything: 12 speakers on the Middle East
 * Heart Failure Conference read "Physician" (typed on Oct 20) and 31 were
 * empty, while their registration, and the screen, said Faculty. The website
 * sync copies this field.
 *
 *   - a live registration on a Faculty type: the plain word "Faculty"
 *     (SPEAKER_API_REGISTRATION_TYPE, never the type's own name or the longer
 *     picker label: the website shows it)
 *   - anyone else: the speaker's own text, exactly as stored. A speaker whose
 *     registration is on a delegate type keeps what the organiser saved for
 *     the website; the API never starts saying "Physician" for them.
 */
export function speakerApiRegistrationType(
  ownType: string | null | undefined,
  registration: { status: string; ticketType?: { isFaculty?: boolean | null } | null } | null | undefined,
): string | null {
  const live = !!registration && registration.status !== "CANCELLED";
  if (live && registration.ticketType?.isFaculty === true) return SPEAKER_API_REGISTRATION_TYPE;
  return ownType ?? null;
}

/** The one line an export or a list prints: the registration's type when there is a live one, else the speaker's own text. */
export function speakerRegistrationTypeName(
  ownType: string | null | undefined,
  registration: SpeakerLinkedRegistration | null | undefined,
): string | null {
  return speakerRegistrationTypeView(ownType, registration).typeName;
}
