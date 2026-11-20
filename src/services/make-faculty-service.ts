/**
 * "Make Faculty": move a speaker's registration onto the event's Faculty type
 * (owner, Nov 20, 2026; plan docs/ABSTRACT_AUTHOR_REGISTRATION_PLAN.md step 6,
 * decision P5).
 *
 * WHO IT IS FOR. A person holds one registration per event and the first one
 * wins, so someone who registered as a delegate, or signed up to submit an
 * abstract, and was invited as a speaker AFTERWARDS is stuck on that
 * registration: adding them as a speaker links it, confirming them settles
 * only a Faculty registration, and the sheet refuses Faculty as a type. This
 * is the one way onto Faculty for a registration that already exists, and it
 * is the organisers' statement "this one is faculty" that the Speakers page
 * and the Registrations filters read (speaker-kinds.ts).
 *
 * ONLY FOR A SPEAKER. The registration must belong to a speaker record on the
 * event: the record that points at it, or one with the same address. An
 * ordinary delegate is refused. Faculty is for the people the organisers
 * invite.
 *
 * MONEY NEVER DISAPPEARS (P5):
 *   - nothing owed (Complimentary, a free rate, or fully refunded): moves.
 *   - owing: moves only when the caller sends back the amount it was shown
 *     (`confirmWaive`), so the fee being waived was read by a person. An open
 *     invoice is cancelled (never deleted) and named in the history.
 *   - a payment held, in part or in full: refused until it is refunded
 *     through the refund flow.
 *   - paid by a sponsor, part of a group, or a card payment in progress:
 *     refused; each is settled on the registration's own page first.
 *
 * NO SECOND RULE FOR THE MOVE. The change itself is the single registration's
 * own `updateRegistration` (the seat planner, the optimistic lock, the price
 * re-stamp, the history), told through `toFaculty` that this destination is
 * allowed. The delegate seat is released there. The barcode is the row's own
 * and does not change.
 *
 * MADE BY HAND. The registration is marked as made Faculty by a person
 * (`FACULTY_BY_HAND_SOURCE`, the mark of Add registration as Faculty), which
 * is what lists someone who came through a sign-up door with the invited
 * speakers (speaker-kinds.ts). What that mark means for the row from then on
 * (review of 66969977): it is a registration in its own right, not the
 * automatic companion of the speaker record. Deleting the speaker does not
 * delete it, a speaker's decline does not cancel it, a change of the
 * speaker's address is not copied to it, and its name is not locked to the
 * speaker's. Moved back off Faculty it is a delegate with a seat again. All
 * of that suits a registration that began as the person's own and may carry
 * a payment history.
 *
 * WHO MAY SEE AND WAIVE. The amount owed and the invoice numbers are shown
 * only to a caller who may see amounts (`maySeeAmounts`), and an invoice is
 * cancelled only for one who may edit invoices (`mayCancelInvoices`); the
 * route judges both. Without them a registration that owes, or has an open
 * invoice, is refused, with no figure in the answer.
 *
 * Errors as values; never throws. `preview: true` answers what would happen
 * and changes nothing: the dialog shows it before anyone confirms.
 */
import { PaymentStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { equalsIgnoringCase } from "@/lib/like-escape";
import { FACULTY_BADGE } from "@/lib/faculty-registration";
import { PRESENTER_BADGE_TYPE } from "@/lib/author-facts";
import { cancelInvoice } from "@/lib/invoice-service";
import { computeRegistrationFinancials, readRegistrationBasePrice } from "@/lib/registration-financials";
import { ensureFacultyTicketType } from "@/lib/speaker-companion";
import { HELD_PAYMENT_TOLERANCE, heldPaymentSum } from "@/lib/held-payments";
import { updateRegistration } from "@/services/registration-service";

export interface MakeFacultyInput {
  eventId: string;
  organizationId: string;
  actorUserId: string;
  registrationId: string;
  /** Answer what would happen; change nothing. */
  preview?: boolean;
  /** The amount owing the caller was shown and agrees to waive. Needed only when something is owed. */
  confirmWaive?: number;
  /** The caller may see amounts (finance.view). Without it a registration that owes is refused. */
  maySeeAmounts: boolean;
  /** The caller may cancel invoices (invoices.write on the event). Without it one with an open invoice is refused. */
  mayCancelInvoices: boolean;
  source: "rest" | "mcp";
  requestIp?: string | null;
}

/** What the move does, in the terms the dialog and the history use. */
export interface MakeFacultyPlan {
  registrationId: string;
  speaker: { id: string; name: string };
  /** The type and rate it leaves; null where it had none. */
  fromType: string | null;
  fromRate: string | null;
  /** The fee that will no longer be owed; null when nothing is. */
  owing: { amount: number; currency: string } | null;
  /** Open invoices that are cancelled with the move. */
  invoices: { id: string; invoiceNumber: string }[];
  /** The badge type before, and after: Faculty, unless one the team chose is kept. */
  badge: { from: string | null; to: string | null };
}

export type MakeFacultyErrorCode =
  | "REGISTRATION_NOT_FOUND"
  | "CANCELLED"
  | "ALREADY_FACULTY"
  | "NO_SPEAKER"
  | "SPEAKER_HAS_OTHER_REGISTRATION"
  | "HAS_PAYMENT"
  | "PAYMENT_PENDING"
  | "NEEDS_FINANCE"
  | "SPONSOR_PAID"
  | "GROUP_MEMBER"
  | "CHECKOUT_OPEN"
  | "CONFIRM_WAIVE"
  | "STALE_WRITE"
  | "UNKNOWN";

export type MakeFacultyResult =
  | { ok: true; moved: boolean; plan: MakeFacultyPlan; invoicesNotCancelled: string[] }
  | { ok: false; code: MakeFacultyErrorCode; message: string; plan?: MakeFacultyPlan };

/** Open: issued or drafted, and neither paid nor already cancelled. A receipt or a credit note is never one. */
const OPEN_INVOICE_STATUSES = ["DRAFT", "SENT", "OVERDUE"] as const;
const CENT = HELD_PAYMENT_TOLERANCE;

const REGISTRATION_SELECT = {
  id: true,
  status: true,
  paymentStatus: true,
  badgeType: true,
  groupId: true,
  refundedAmount: true,
  originalPrice: true,
  discountAmount: true,
  stripeCheckoutSessionId: true,
  updatedAt: true,
  createdSource: true,
  attendee: { select: { email: true } },
  ticketType: { select: { name: true, isFaculty: true, price: true, currency: true } },
  pricingTier: { select: { name: true, price: true, currency: true } },
  payments: { select: { amount: true, refundedAmount: true, status: true } },
  invoices: { where: { type: "INVOICE", status: { not: "CANCELLED" } }, select: { id: true, invoiceNumber: true, status: true } },
  event: { select: { taxRate: true, taxLabel: true } },
} as const;

type SpeakerRecord = { id: string; firstName: string; lastName: string; sourceRegistrationId: string | null };

/**
 * The speaker record a registration belongs to on its event: the one that
 * points at it, else the oldest with the same address (exact, whatever its
 * case). THE answer for "is this registration a speaker's": the sheet's Make
 * Faculty button asks it too (the registration detail route).
 */
export async function findSpeakerRecordOf(
  eventId: string,
  registration: { id: string; attendee: { email: string } | null },
): Promise<SpeakerRecord | null> {
  const select = { id: true, firstName: true, lastName: true, sourceRegistrationId: true } as const;
  const pointed = await db.speaker.findFirst({ where: { eventId, sourceRegistrationId: registration.id }, select, orderBy: { createdAt: "asc" } });
  if (pointed || !registration.attendee?.email) return pointed;
  return db.speaker.findFirst({ where: { eventId, email: equalsIgnoringCase(registration.attendee.email) }, select, orderBy: { createdAt: "asc" } });
}

/**
 * The speaker record points at its registration from here (it may have been found by address only). Guarded on
 * the pointer that was read, so a record someone has since pointed elsewhere is left alone; a failure is logged
 * and healed by the next attempt, which answers ALREADY_FACULTY.
 */
async function pointSpeakerAt(eventId: string, speaker: SpeakerRecord, registrationId: string): Promise<void> {
  if (speaker.sourceRegistrationId === registrationId) return;
  try {
    const { count } = await db.speaker.updateMany({
      where: { id: speaker.id, eventId, sourceRegistrationId: speaker.sourceRegistrationId },
      data: { sourceRegistrationId: registrationId },
    });
    if (count === 0) apiLogger.warn({ msg: "make-faculty:speaker-link-not-made", eventId, registrationId, speakerId: speaker.id });
  } catch (err) {
    apiLogger.error({ err, msg: "make-faculty:speaker-link-failed", eventId, registrationId, speakerId: speaker.id });
  }
}

/** The badge after the move: Faculty where none was chosen (blank, or the presenter's), else the one the team set. */
function badgeAfter(current: string | null): string | null {
  const own = (current ?? "").trim();
  return own === "" || own === PRESENTER_BADGE_TYPE ? FACULTY_BADGE : current;
}

export async function makeRegistrationFaculty(input: MakeFacultyInput): Promise<MakeFacultyResult> {
  const { eventId, registrationId } = input;
  const refuse = (code: MakeFacultyErrorCode, message: string, plan?: MakeFacultyPlan): MakeFacultyResult => {
    apiLogger.warn({ msg: "make-faculty:refused", eventId, registrationId, code, userId: input.actorUserId });
    return { ok: false, code, message, ...(plan && { plan }) };
  };
  try {
    const row = await db.registration.findFirst({ where: { id: registrationId, eventId }, select: REGISTRATION_SELECT });
    if (!row) return refuse("REGISTRATION_NOT_FOUND", "Registration not found.");
    if (row.status === "CANCELLED") return refuse("CANCELLED", "This registration is cancelled.");

    const speaker = await findSpeakerRecordOf(eventId, row);
    if (!speaker) {
      return refuse("NO_SPEAKER", "Faculty is for the event's speakers and committee. This person is not on the Speakers list: add them there first.");
    }
    // Their speaker record already carries another live registration: two registrations for one person.
    if (speaker.sourceRegistrationId && speaker.sourceRegistrationId !== row.id) {
      const other = await db.registration.findFirst({
        where: { id: speaker.sourceRegistrationId, eventId, status: { not: "CANCELLED" } },
        select: { serialId: true },
      });
      if (other) {
        return refuse(
          "SPEAKER_HAS_OTHER_REGISTRATION",
          `This speaker already has another registration on the event (#${String(other.serialId ?? "").padStart(3, "0")}). Cancel the one that is not needed first.`,
        );
      }
    }

    if (row.ticketType?.isFaculty) {
      // A run that moved the registration and then failed to point the speaker at it is finished here.
      await pointSpeakerAt(eventId, speaker, row.id);
      return refuse("ALREADY_FACULTY", "This registration is already on the Faculty type.");
    }
    // ── Money (P5) ──────────────────────────────────────────────────────────
    if (row.paymentStatus === PaymentStatus.INCLUSIVE) {
      return refuse("SPONSOR_PAID", "This registration is paid by a sponsor. Change its payment status on the Billing tab first.");
    }
    if (row.groupId) {
      return refuse("GROUP_MEMBER", "This registration is part of a group, which is paid as a group. It cannot be made Faculty from here.");
    }
    if (row.paymentStatus === PaymentStatus.PENDING) {
      return refuse("PAYMENT_PENDING", "A payment is in progress or awaiting confirmation on this registration. Try again when it has completed or failed.");
    }
    // An open card checkout can still turn the row Paid, whatever it says now.
    if (row.stripeCheckoutSessionId) {
      return refuse("CHECKOUT_OPEN", "A card payment page is open for this registration. Try again when it has been paid or has expired.");
    }
    const held = heldPaymentSum(row.payments);
    const paidInvoice = row.invoices.some((i) => i.status === "PAID");
    if (held > CENT || paidInvoice) {
      return refuse(
        "HAS_PAYMENT",
        "This registration has a payment on it. Refund it first (Billing tab: credit note, then refund); Faculty registrations carry no money.",
      );
    }
    // Marked Paid with no payment recorded: someone set it by hand. It is theirs to correct.
    if (row.paymentStatus === PaymentStatus.PAID) {
      return refuse("HAS_PAYMENT", "This registration is marked Paid, with no payment recorded. Correct its payment status on the Billing tab first.");
    }
    const currency = row.pricingTier?.currency ?? row.ticketType?.currency ?? "USD";
    const financials = computeRegistrationFinancials({
      subtotal: readRegistrationBasePrice(row),
      discount: row.discountAmount ? Number(row.discountAmount) : 0,
      taxRate: row.event.taxRate ? Number(row.event.taxRate) : null,
      taxLabel: row.event.taxLabel,
      currency,
      totalPaid: 0,
    });
    // Complimentary and fully refunded owe nothing, whatever the price reads.
    const nothingOwed = row.paymentStatus === PaymentStatus.COMPLIMENTARY || row.paymentStatus === PaymentStatus.REFUNDED;
    const owing = !nothingOwed && financials.balanceDue > CENT ? { amount: financials.balanceDue, currency } : null;

    const openInvoices = row.invoices.filter((i) => (OPEN_INVOICE_STATUSES as readonly string[]).includes(i.status));
    // Before anything is said about money: the amount and the invoice numbers are not this caller's to read.
    if (owing && !input.maySeeAmounts) {
      return refuse("NEEDS_FINANCE", "A fee is owed on this registration. Someone who can see amounts has to make it Faculty, because the fee is waived.");
    }
    if (openInvoices.length > 0 && !(input.maySeeAmounts && input.mayCancelInvoices)) {
      return refuse("NEEDS_FINANCE", "This registration has an open invoice, which is cancelled with the move. Someone who can edit invoices has to make it Faculty.");
    }
    const plan: MakeFacultyPlan = {
      registrationId: row.id,
      speaker: { id: speaker.id, name: `${speaker.firstName} ${speaker.lastName}`.trim() },
      fromType: row.ticketType?.name ?? null,
      fromRate: row.pricingTier?.name ?? null,
      owing,
      invoices: openInvoices.map((i) => ({ id: i.id, invoiceNumber: i.invoiceNumber })),
      badge: { from: row.badgeType, to: badgeAfter(row.badgeType) },
    };
    if (input.preview) return { ok: true, moved: false, plan, invoicesNotCancelled: [] };

    if (owing && (input.confirmWaive === undefined || Math.abs(input.confirmWaive - owing.amount) > CENT)) {
      return refuse(
        "CONFIRM_WAIVE",
        `${owing.currency} ${owing.amount.toFixed(2)} is owed on this registration and will no longer be. Confirm to make it Faculty.`,
        plan,
      );
    }

    // ── The move: the single registration's own change ─────────────────────
    const facultyTypeId = await ensureFacultyTicketType(eventId);
    const moved = await updateRegistration({
      eventId,
      registrationId: row.id,
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      source: input.source,
      requestIp: input.requestIp ?? null,
      // Whoever changed it since it was read wins: nothing is moved on stale facts.
      expectedUpdatedAt: row.updatedAt.toISOString(),
      ticketTypeId: facultyTypeId,
      toFaculty: true,
      // A fully refunded registration keeps saying so: its money history is on it.
      ...(row.paymentStatus !== PaymentStatus.REFUNDED && row.paymentStatus !== PaymentStatus.COMPLIMENTARY && { paymentStatus: PaymentStatus.COMPLIMENTARY }),
      ...(plan.badge.to !== plan.badge.from && { badgeType: plan.badge.to }),
    });
    if (!moved.ok) {
      if (moved.code === "STALE_WRITE") return refuse("STALE_WRITE", moved.message);
      // A payment landed between the read above and the row lock.
      if (moved.code === "FACULTY_HAS_PAYMENT") return refuse("HAS_PAYMENT", moved.message);
      apiLogger.error({ msg: "make-faculty:update-refused", eventId, registrationId, code: moved.code, detail: moved.message });
      return { ok: false, code: "UNKNOWN", message: moved.message };
    }

    await pointSpeakerAt(eventId, speaker, row.id);

    // Open invoices are cancelled, never deleted. One that fails is named: the move stands.
    const invoicesNotCancelled: string[] = [];
    for (const invoice of openInvoices) {
      try {
        await cancelInvoice(invoice.id, { actorUserId: input.actorUserId, source: input.source, organizationId: input.organizationId, ip: input.requestIp ?? undefined });
      } catch (err) {
        apiLogger.error({ err, msg: "make-faculty:invoice-cancel-failed", eventId, registrationId, invoiceId: invoice.id });
        invoicesNotCancelled.push(invoice.invoiceNumber);
      }
    }

    // Its own line in the history: what was waived, and by whom. The type and
    // payment change themselves are in the update's row beside it.
    await db.auditLog
      .create({
        data: {
          eventId,
          userId: input.actorUserId,
          action: "MAKE_FACULTY",
          entityType: "Registration",
          entityId: row.id,
          changes: {
            source: input.source,
            speakerId: speaker.id,
            fromType: plan.fromType,
            fromRate: plan.fromRate,
            waived: owing,
            invoicesCancelled: openInvoices.filter((i) => !invoicesNotCancelled.includes(i.invoiceNumber)).map((i) => i.invoiceNumber),
            invoicesNotCancelled,
            badge: plan.badge,
            ...(input.requestIp ? { ip: input.requestIp } : {}),
          },
        },
      })
      .catch((err) => apiLogger.error({ err, msg: "make-faculty:audit-write-failed", eventId, registrationId }));

    apiLogger.info({
      msg: "make-faculty:done",
      eventId,
      registrationId,
      speakerId: speaker.id,
      userId: input.actorUserId,
      waived: owing?.amount ?? 0,
      invoicesCancelled: openInvoices.length - invoicesNotCancelled.length,
      invoicesNotCancelled: invoicesNotCancelled.length,
    });
    return { ok: true, moved: true, plan, invoicesNotCancelled };
  } catch (err) {
    apiLogger.error({ err, msg: "make-faculty:failed", eventId, registrationId });
    return { ok: false, code: "UNKNOWN", message: "The registration could not be made Faculty." };
  }
}
