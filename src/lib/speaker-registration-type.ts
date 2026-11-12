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
 */

export interface SpeakerLinkedRegistration {
  serialId?: number | null;
  status: string;
  paymentStatus?: string | null;
  ticketType?: { name: string; isFaculty?: boolean | null } | null;
}

export type SpeakerRegistrationTypeView =
  /** No live registration: the speaker's own text applies, and may be edited. */
  | { kind: "own"; typeName: string | null }
  | {
      kind: "registration";
      /** The registration's type, or NO_TYPE_LABEL when it has none yet. */
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
  return {
    kind: "registration",
    typeName: registration.ticketType?.name.trim() || NO_TYPE_LABEL,
    isFaculty: registration.ticketType?.isFaculty === true,
    serial: registration.serialId != null ? String(registration.serialId).padStart(3, "0") : null,
    note: noteFor(registration),
  };
}

/** The one line an export or a list prints: the registration's type when there is a live one, else the speaker's own text. */
export function speakerRegistrationTypeName(
  ownType: string | null | undefined,
  registration: SpeakerLinkedRegistration | null | undefined,
): string | null {
  return speakerRegistrationTypeView(ownType, registration).typeName;
}
