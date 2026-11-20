/**
 * THE rule for whether an event is still taking abstracts from AUTHORS
 * (owner, Nov 20, 2026): the switch is on (Settings, Abstracts, "Allow abstract
 * submissions"; never on a webinar) and the deadline, when one is set, has not
 * passed.
 *
 * Until that day only the public sign-up door asked. An author who already had
 * an account went on submitting from their own portal after the deadline: on
 * MEHF2027, closed since Nov 8, three abstracts arrived on Nov 20. Every door
 * an author can start or submit an abstract through now asks here:
 *   - the public sign-up (`public/.../submitter`) and the sign-in half of it
 *     (`public/.../abstract-start`);
 *   - creating an abstract, draft or submitted (`POST abstracts`);
 *   - submitting a draft (`PUT abstracts/[id]`, DRAFT to SUBMITTED);
 *   - the author's own screens, which hide the buttons and say why.
 *
 * What stays open after closing, on purpose:
 *   - STAFF. An entry made on someone's behalf after the deadline is a
 *     deliberate act (the session-proposal deadline's rule, submission-deadline.ts).
 *   - Reading, and editing a draft (which can then no longer be submitted).
 *     Only new intake stops. An abstract already submitted was locked to its
 *     author before this rule and still is.
 *
 * To reopen, the organiser moves the deadline forward or turns the switch on.
 *
 * Client-safe: pure, no db.
 */
import { abstractSubmissionsOpen } from "@/lib/webinar";
import { isDeadlinePassed, readAbstractDeadline } from "@/lib/submission-deadline";

export type AbstractIntakeClosedCode = "SUBMISSIONS_CLOSED" | "DEADLINE_PASSED";

export interface AbstractIntakeClosed {
  code: AbstractIntakeClosedCode;
  /** For the author: a full sentence. */
  message: string;
}

/** Null while the event takes abstracts from authors; otherwise why not. */
export function abstractIntakeClosed(event: { eventType?: string | null; settings?: unknown }): AbstractIntakeClosed | null {
  if (!abstractSubmissionsOpen(event)) {
    return { code: "SUBMISSIONS_CLOSED", message: "Abstract submissions are not open for this event." };
  }
  if (isDeadlinePassed(readAbstractDeadline(event.settings))) {
    return { code: "DEADLINE_PASSED", message: "The abstract submission deadline has passed." };
  }
  return null;
}
