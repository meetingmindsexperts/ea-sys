/**
 * What a badge print left out, told to the person who pressed Print (owner,
 * Nov 13, 2026).
 *
 * The badge route prints only whom the door would admit (`isPaymentAdmissible`
 * in check-in.ts). When NOBODY in the selection qualifies it refuses, with a
 * message. When only SOME do not, it used to return the PDF for the rest and
 * say nothing: a bulk print of 50 came back as 47 badges and "Badges ready to
 * print", and the operator found the three missing by counting paper.
 *
 * The response body is the PDF, so the counts travel in headers. One module
 * writes them (the route) and reads them (the Badges dialog, the only screen
 * that sends more than one registration), so the names and the wording cannot
 * drift. Client-safe.
 *
 * Two things are told apart (review of b19e5e44). "Payment due" is someone who
 * really owes, and it comes with the remedy and their numbers. Everyone else
 * in the selection who gets no badge (a virtual attendee, a cancelled or
 * refunded registration, a row deleted since the list loaded) is only
 * counted, so the figures add up to what was selected without telling the
 * operator to "record the payment" on a cancelled registration.
 */

export const BADGES_PRINTED_HEADER = "X-Badges-Printed";
export const BADGES_PAYMENT_DUE_HEADER = "X-Badges-Payment-Due";
/** The registration numbers left out, as the list shows them ("069"), comma-separated, capped. */
export const BADGES_PAYMENT_DUE_NUMBERS_HEADER = "X-Badges-Payment-Due-Numbers";

/** The rest of the selection that gets no badge, for a reason that is not money owed. */
export const BADGES_NO_BADGE_HEADER = "X-Badges-No-Badge";

/** How many numbers are named: enough to act on, short enough for a header and a toast. */
export const MAX_LEFT_OUT_NUMBERS = 20;

export interface BadgePrintResult {
  /** Badges in the PDF. Null when the response did not say (an older server mid-deploy). */
  printed: number | null;
  /** Registrations in the selection left out because payment is due. */
  paymentDue: number;
  /** Their registration numbers, lowest first, at most MAX_LEFT_OUT_NUMBERS. */
  paymentDueNumbers: string[];
  /** Others in the selection with no badge: virtual, cancelled, refunded or no longer there. */
  noBadge: number;
}

/** A registration number as the Registrations list prints it. */
function registrationNumber(serialId: number): string {
  return String(serialId).padStart(3, "0");
}

/** The headers the badge route sends with its PDF. */
export function badgePrintHeaders(
  printed: number,
  leftOutForPayment: readonly { serialId: number | null }[],
  noBadge = 0,
): Record<string, string> {
  const numbers = leftOutForPayment
    .map((r) => r.serialId)
    .filter((n): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0)
    .sort((a, b) => a - b)
    .slice(0, MAX_LEFT_OUT_NUMBERS)
    .map(registrationNumber);
  return {
    [BADGES_PRINTED_HEADER]: String(printed),
    [BADGES_PAYMENT_DUE_HEADER]: String(leftOutForPayment.length),
    [BADGES_NO_BADGE_HEADER]: String(Math.max(0, Math.trunc(noBadge))),
    ...(numbers.length > 0 ? { [BADGES_PAYMENT_DUE_NUMBERS_HEADER]: numbers.join(",") } : {}),
  };
}

function readCount(value: string | null): number | null {
  if (value == null || !/^\d{1,9}$/.test(value.trim())) return null;
  return Number(value.trim());
}

/** Reads the route's headers. Anything missing or malformed reads as "nothing left out". */
export function readBadgePrintResult(headers: { get(name: string): string | null }): BadgePrintResult {
  const paymentDueNumbers = (headers.get(BADGES_PAYMENT_DUE_NUMBERS_HEADER) ?? "")
    .split(",")
    .map((n) => n.trim())
    .filter((n) => /^\d{1,9}$/.test(n))
    .slice(0, MAX_LEFT_OUT_NUMBERS);
  return {
    printed: readCount(headers.get(BADGES_PRINTED_HEADER)),
    paymentDue: readCount(headers.get(BADGES_PAYMENT_DUE_HEADER)) ?? 0,
    paymentDueNumbers,
    noBadge: readCount(headers.get(BADGES_NO_BADGE_HEADER)) ?? 0,
  };
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/** ": 069, 071, 076" or ": 001, 002 and 3 more"; empty when no number is known. */
function namedNumbers(result: BadgePrintResult): string {
  if (result.paymentDueNumbers.length === 0) return "";
  const more = result.paymentDue - result.paymentDueNumbers.length;
  const tail = more > 0 ? ` and ${more} more` : "";
  return `: ${result.paymentDueNumbers.join(", ")}${tail}`;
}

/** "3 left out, payment due: 069, 071, 076. Record the payment ...", or empty. */
function paymentDueSentence(result: BadgePrintResult): string {
  if (result.paymentDue <= 0) return "";
  const remedy = plural(
    result.paymentDue,
    "Record the payment or set it to Complimentary, then print that one.",
    "Record the payment or set them to Complimentary, then print those.",
  );
  return ` ${result.paymentDue} left out, payment due${namedNumbers(result)}. ${remedy}`;
}

/** "2 others in the selection get no badge (virtual, cancelled or refunded).", or empty. */
function noBadgeSentence(result: BadgePrintResult): string {
  if (result.noBadge <= 0) return "";
  // "other" only beside someone already named as left out.
  const who = result.paymentDue > 0 ? plural(result.noBadge, "other", "others") : "";
  const verb = plural(result.noBadge, "gets", "get");
  return ` ${[result.noBadge, who].filter(Boolean).join(" ")} in the selection ${verb} no badge (virtual, cancelled or refunded).`;
}

/**
 * What to tell the operator when a print left people out, or null when it left
 * nobody out (then the screen keeps its usual "ready to print").
 */
export function badgeLeftOutMessage(result: BadgePrintResult): string | null {
  if (result.paymentDue <= 0 && result.noBadge <= 0) return null;
  const ready =
    result.printed == null
      ? "Badges ready to print."
      : `${result.printed} ${plural(result.printed, "badge", "badges")} ready to print.`;
  return `${ready}${paymentDueSentence(result)}${noBadgeSentence(result)}`;
}
