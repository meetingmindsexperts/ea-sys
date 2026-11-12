/**
 * What an organiser (or the agent) is told about the speaker's registration
 * after the speaker was set to Confirmed (owner, Nov 12, 2026). One wording for
 * the speaker page, the speaker sheet and the agent's update_speaker, so the
 * three cannot describe one outcome three ways.
 *
 * The outcomes are settleFacultyRegistration's (speaker-companion.ts). Pure and
 * client-safe: only the outcome's name crosses the wire.
 */
export type RegistrationSettleNotice = { kind: "info" | "error"; text: string };

export function registrationSettleNotice(outcome: string | null | undefined): RegistrationSettleNotice | null {
  if (outcome === "settled") {
    return { kind: "info", text: "Their Faculty registration is now Confirmed and Complimentary." };
  }
  if (outcome === "not-faculty") {
    return {
      kind: "info",
      text: "Their registration is on a delegate type, so it was left as it is. Change its status and payment on the registration if they attend as faculty.",
    };
  }
  if (outcome === "failed") {
    return { kind: "error", text: "The speaker is confirmed, but their registration could not be updated. Change it on the registration." };
  }
  // "none" (no registration) and "unchanged" (already settled, cancelled, or money is involved): nothing to say.
  return null;
}

/**
 * What Speakers, Import from Contacts says when it is done (review of
 * efb00d74). The dialog promises a complimentary Faculty registration for each
 * person; this is where the organiser learns when that is not what happened:
 * someone already registered was linked to the registration they had, on
 * whatever type and payment it stands, and someone whose registration could
 * not be made has none. Neither heals by importing again (the person is a
 * speaker now and is skipped), so both are said once, here.
 */
export interface SpeakerContactImportResult {
  created: number;
  skipped: number;
  /** New complimentary Faculty registrations. */
  facultyRegistrations?: number;
  /** Speakers linked to a registration the person already had. */
  linkedRegistrations?: number;
  /** Speakers whose registration could not be made. */
  failedRegistrations?: number;
}

const people = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function speakerContactImportNotice(result: SpeakerContactImportResult): { kind: "success" | "warning"; text: string } {
  const linked = result.linkedRegistrations ?? 0;
  const failed = result.failedRegistrations ?? 0;
  const parts = [`Imported ${people(result.created, "speaker", "speakers")}`];
  if (result.skipped > 0) parts.push(`${result.skipped} skipped (already a speaker)`);
  if ((result.facultyRegistrations ?? 0) > 0) parts.push(`${result.facultyRegistrations} given a Faculty registration`);
  if (linked > 0) {
    parts.push(`${linked} already registered: linked to the registration they had, so check its type and payment on the speaker`);
  }
  if (failed > 0) {
    parts.push(`${failed} have no registration yet: open the speaker and use Grant Registration`);
  }
  return { kind: linked > 0 || failed > 0 ? "warning" : "success", text: `${parts.join(". ")}.` };
}
