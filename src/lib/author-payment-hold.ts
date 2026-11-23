/**
 * THE rule for whether an abstract author may pay their registration fee
 * online yet (owner, Nov 23, 2026).
 *
 * The house rule is pay later: an author is told the fee at sign-up, and the
 * organisers confirm it (or make the registration Complimentary) once the
 * abstract is decided. Roughly 1 presenter in 20 to 30 ends up paying, so a
 * payment taken before the decision is usually one to refund.
 *
 * Until this day only the sign-up's own emails obeyed the event's Pay Now
 * switch. The portal, the event's registration page, Resend confirmation, the
 * payment reminder and the checkout itself all offered Pay Now regardless, and
 * since the same day every new author's registration is in their account, so
 * every one of them could reach it.
 *
 * ON HOLD: a registration the abstract sign-up made (`PUBLIC_SUBMITTER`, which
 * only that sign-up writes), while the event's switch is off (Settings,
 * Abstracts, "Let abstract submitters pay online";
 * `settings.presenterRegistration.payNowEnabled`). The organisers open paying
 * for the whole event by turning the switch on, typically when decisions are
 * announced. It is event-wide on purpose (owner, option A): opening it per
 * person as each abstract is decided would tell an author the result before
 * the announcement.
 *
 * Every door that offers or takes an online payment asks this: the checkout
 * (which refuses), the pay page, My events, the event's registration page,
 * both confirmation resends, and the payment reminder, single and bulk. A test
 * lists the doors (`author-payment-hold-doors.test.ts`): **never offer Pay Now
 * or take a payment on a registration without asking it**.
 *
 * NOT held: someone who registered as a delegate and then submitted (their
 * registration is an ordinary one), and a registration the organisers granted
 * by hand (they have already decided). Staff are never held: recording a
 * payment, Complimentary and refunds work as before.
 *
 * It says nothing about whether money is owed: a caller asks it only for a
 * registration with a balance.
 *
 * Client-safe: pure.
 */
import { isPresenterPayNowEnabled } from "@/lib/presenter-registration-settings";

/** The entry path only the abstract sign-up writes (presenter-signup.ts). */
export const AUTHOR_SIGNUP_SOURCE = "PUBLIC_SUBMITTER";

/** What the checkout answers for a registration on hold. */
export const AUTHOR_PAYMENT_HOLD_CODE = "AUTHOR_PAYMENT_ON_HOLD";

/** What the person is told instead of Pay Now, on a page. */
export const AUTHOR_PAYMENT_HOLD_NOTE =
  "Online payment is not open yet. The organizing team will confirm your registration fee once your submission has been reviewed.";

/**
 * Is online payment held for this registration? `eventSettings` is the
 * registration's own event's settings JSON; anything unreadable there reads as
 * "switch off", so a damaged blob holds payment and never opens it.
 */
export function authorPaymentOnHold(
  registration: { createdSource?: string | null },
  eventSettings: unknown,
): boolean {
  if (registration.createdSource !== AUTHOR_SIGNUP_SOURCE) return false;
  return !isPresenterPayNowEnabled(eventSettings);
}
