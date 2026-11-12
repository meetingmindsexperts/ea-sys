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
import { displayRegistrationType } from "@/lib/faculty-filter";

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
    serial: registration.serialId != null ? String(registration.serialId).padStart(3, "0") : null,
    note: noteFor(registration),
  };
}

/**
 * What the speakers API serves as `registrationType`: the registration's own
 * type, by the same name the screens use (owner, Nov 12, 2026: "if reg type is
 * changed to physician, then API should return physician, and faculty, then
 * faculty, if nurse then nurse. They should not diverge").
 *
 * The API served the speaker's own hand-edited text. On the Middle East Heart
 * Failure Conference 12 speakers read "Physician" there and 31 nothing, while
 * their registration, and the screen, said Faculty. The website sync (n8n to
 * Webflow) copies this field.
 *
 *   - a live registration with a type: that type's name, "Faculty" for a
 *     Faculty type (displayRegistrationType), trimmed
 *   - no live registration, or one with no type yet: the speaker's own text,
 *     as stored. There is nothing truer to say.
 *
 * So the value follows the registration: change the registration's type and
 * the API, the screen and the export all change with it. It never follows the
 * speaker's own text once a typed registration exists.
 */
export function speakerApiRegistrationType(
  ownType: string | null | undefined,
  registration: { status: string; ticketType?: { name?: string | null; isFaculty?: boolean | null } | null } | null | undefined,
): string | null {
  const live = !!registration && registration.status !== "CANCELLED";
  if (!live || !registration.ticketType) return ownType ?? null;
  const name = displayRegistrationType({ ticketTypeName: registration.ticketType.name, isFaculty: registration.ticketType.isFaculty }, "").trim();
  return name || (ownType ?? null);
}

/** The one line an export or a list prints: the registration's type when there is a live one, else the speaker's own text. */
export function speakerRegistrationTypeName(
  ownType: string | null | undefined,
  registration: SpeakerLinkedRegistration | null | undefined,
): string | null {
  return speakerRegistrationTypeView(ownType, registration).typeName;
}
