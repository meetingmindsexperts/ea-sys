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
