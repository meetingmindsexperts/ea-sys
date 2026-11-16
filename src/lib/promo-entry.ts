/**
 * A promo code typed on a form and never checked (owner, Nov 16, 2026).
 *
 * The public registration form sent a code only once the Apply button had
 * accepted it. A code typed and left there was dropped without a word: the
 * person registered at the full fee, found it owing on the next page and
 * entered the code again there, where a code that covers the whole fee leaves
 * the registration Unpaid. Thirteen of the twenty nurses on one sponsor's code
 * went that way (4th GCC Hematology Hub).
 *
 * So a form asks `resolveSubmitPromo` before it submits. A typed code is
 * checked first: accepted, it rides the registration; refused, the form stops
 * and says so. When the check itself could not be made (rate limited, offline,
 * overtaken by a newer check), the typed code is SENT and the register route
 * judges it: that route claims a code atomically and refuses a bad one with
 * its own message, so nothing is dropped and nothing is granted wrongly. A
 * failed check must never tell someone to clear a good code (review of
 * 73ef6416: the check is limited to 10 per 15 minutes per address, and a
 * sponsor's delegates share a hospital's address).
 *
 * The onsite desk has always refused a typed, unapplied code (desk-panel.tsx).
 * Client-safe, no dependencies.
 */

/** The code check's answer, as far as these rules read it. */
export interface PromoAnswer {
  valid?: boolean;
  /** The code the answer is about, as the server stores it. */
  code?: string;
}

/** A valid answer counts only for the code it was given for. */
function acceptedFor(code: string, result: PromoAnswer | null): boolean {
  if (!result?.valid) return false;
  return (result.code ?? "").trim().toUpperCase() === code.toUpperCase();
}

/**
 * The code the person typed that no check has accepted, or null when there is
 * nothing to check: no code, a code already accepted, or a field the form is
 * not showing (a submit the person cannot correct must not be blocked).
 *
 * An answer for a DIFFERENT code is not an acceptance: typing on while a check
 * is in flight left the field reading SEHA26 under SEHA's green box, and SEHA
 * was sent.
 */
export function unappliedPromoCode(typed: string, fieldShown: boolean, result: PromoAnswer | null): string | null {
  const code = typed.trim();
  if (!fieldShown || !code) return null;
  return acceptedFor(code, result) ? null : code;
}

/** What a check of one code came back with. */
export type PromoCheckOutcome<R extends PromoAnswer> =
  /** The server judged the code: `result.valid` says how. */
  | { kind: "answered"; result: R }
  /** Nobody judged it: rate limited, offline, a server error, or overtaken by a newer check. */
  | { kind: "unchecked" };

/** What the submit does about the promo code. */
export type SubmitPromo<R extends PromoAnswer> =
  /**
   * Send the registration, with `code` when there is one. `judged` is false
   * when the code goes unchecked and the register route decides; `result` is
   * the accepted answer, or null when there is none.
   */
  | { action: "send"; code: string | undefined; result: R | null; judged: boolean }
  /** The server refused the typed code: stop and say so. */
  | { action: "stop"; code: string; result: R };

export async function resolveSubmitPromo<R extends PromoAnswer>(input: {
  /** The text in the code field. */
  typed: string;
  /** The field is on the page, so the person can see and correct it. */
  fieldShown: boolean;
  /** The last answer the form holds. */
  result: R | null;
  /** Checks one code with the server. */
  check: (code: string) => Promise<PromoCheckOutcome<R>>;
}): Promise<SubmitPromo<R>> {
  const typedCode = unappliedPromoCode(input.typed, input.fieldShown, input.result);
  if (!typedCode) {
    const accepted = input.result?.valid ? input.result : null;
    return { action: "send", code: accepted?.code, result: accepted, judged: true };
  }
  const outcome = await input.check(typedCode);
  if (outcome.kind === "unchecked") return { action: "send", code: typedCode, result: null, judged: false };
  if (!outcome.result.valid) return { action: "stop", code: typedCode, result: outcome.result };
  return { action: "send", code: outcome.result.code ?? typedCode, result: outcome.result, judged: true };
}

/** What the form says when the server refused a typed code. */
export function promoStopMessages(code: string, codeRequired: boolean): { toast: string; notice: string } {
  // A sponsor link cannot be registered without a code, so it is not offered.
  if (codeRequired) {
    return {
      toast: `The code ${code} was not accepted. Correct it and try again.`,
      notice: "Your code was not accepted. Correct it and try again.",
    };
  }
  return {
    toast: `The code ${code} was not applied. Correct it, or clear the field to register without a code.`,
    notice: "Your promo code was not applied. Correct it, or clear the field to continue without it.",
  };
}
