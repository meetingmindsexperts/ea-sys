/**
 * What the abstract and proposal sign-up screen says when the organisers
 * already hold a speaker profile for the address and the person must confirm
 * it first (Nov 13, 2026).
 *
 * The screen used to say "We sent you a link" whatever happened, while the
 * route's own message said "We could not send the link just now" when the
 * send failed: the person waited for an email that was never coming. The
 * routes now say which it was (`claimLink` in their answer) and this is the
 * one wording for each case. Pure and client-safe.
 */
export type ClaimLinkState = "sent" | "rate-limited" | "failed";

/** A route that does not say (the other slot during a deploy) is read as before: sent. */
export function readClaimLinkState(value: unknown): ClaimLinkState {
  return value === "rate-limited" || value === "failed" ? value : "sent";
}

const PROFILE_HELD = "The organisers already have a speaker profile for this email.";

export function claimLinkCopy(state: ClaimLinkState): { lead: string; step: string } {
  if (state === "failed") {
    return {
      lead: `${PROFILE_HELD} We could not send the confirmation link just now. Please try again in a few minutes.`,
      step: "Come back to this page in a few minutes and continue again, so we can send the link",
    };
  }
  if (state === "rate-limited") {
    return {
      lead: `${PROFILE_HELD} We sent you a link recently: sign in, then open the latest one to take the profile over, and come back here to finish.`,
      step: "Open the latest confirmation link we emailed you",
    };
  }
  return {
    lead: `${PROFILE_HELD} We sent you a link: sign in, then open it to take the profile over, and come back here to finish.`,
    step: "Open the confirmation link we emailed you",
  };
}
