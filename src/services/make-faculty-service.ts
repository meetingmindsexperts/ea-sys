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
 * (`FACULTY_BY_HAND_SOURCE`), which is what lists someone who submitted with
 * the invited speakers (speaker-kinds.ts): the automatic Faculty registration
 * the old abstract sign-up gave every author says nothing. So it also works
 * on a registration ALREADY on the Faculty type, where it changes only that
 * mark: an invited speaker who later signed in to submit, or an author of the
 * old sign-up the organisers have since invited, is confirmed as faculty.
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
import { FACULTY_BY_HAND_SOURCE } from "@/lib/speaker-kinds";
import { cancelInvoice } from "@/lib/invoice-service";
import { computeRegistrationFinancials, readRegistrationBasePrice } from "@/lib/registration-financials";
import { ensureFacultyTicketType } from "@/lib/speaker-companion";
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
  /** Already on the Faculty type: only the mark "made Faculty by the organisers" is set. */
  alreadyOnFaculty: boolean;
}

export type MakeFacultyErrorCode =
  | "REGISTRATION_NOT_FOUND"
  | "CANCELLED"
  | "ALREADY_FACULTY"
  | "NO_SPEAKER"
  | "SPEAKER_HAS_OTHER_REGISTRATION"
  | "HAS_PAYMENT"
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
/** Something is still being collected, or was: the refund flow decides these, never a type change. */
const PAYMENT_HELD_STATUSES: readonly string[] = [PaymentStatus.PAID, PaymentStatus.PENDING];
/** A cent of tolerance, as the financials use (rounding across partial captures). */
const CENT = 0.01;

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
  payments: { select: { amount: true, status: true } },
  invoices: { where: { type: "INVOICE", status: { not: "CANCELLED" } }, select: { id: true, invoiceNumber: true, status: true } },
  event: { select: { taxRate: true, taxLabel: true } },
} as const;

type SpeakerRecord = { id: string; firstName: string; lastName: string; sourceRegistrationId: string | null; submitterSource: string | null };

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
  const select = { id: true, firstName: true, lastName: true, sourceRegistrationId: true, submitterSource: true } as const;
  const pointed = await db.speaker.findFirst({ where: { eventId, sourceRegistrationId: registration.id }, select, orderBy: { createdAt: "asc" } });
  if (pointed || !registration.attendee?.email) return pointed;
  return db.speaker.findFirst({ where: { eventId, email: equalsIgnoringCase(registration.attendee.email) }, select, orderBy: { createdAt: "asc" } });
}

/**
 * A registration on the Faculty type that does not yet say "the organisers put this person here": the
 * automatic one behind a speaker record that carries a sign-up door (the old abstract sign-up's, or an invited
 * speaker who later signed in to submit), or any other row found on the type. THE answer for whether the sheet
 * offers "Confirm as invited faculty"; the registration detail route asks it too.
 */
export function needsFacultyConfirmation(facts: { onFacultyType: boolean; createdSource: string | null; submitterSource: string | null }): boolean {
  if (!facts.onFacultyType || facts.createdSource === FACULTY_BY_HAND_SOURCE) return false;
  return !(facts.createdSource === "SPEAKER_COMPANION" && facts.submitterSource === null);
}

/** The badge after the move: Faculty where none was chosen (blank, or the presenter's), else the one the team set. */
function badgeAfter(current: string | null): string | null {
  const own = (current ?? "").trim();
  return own === "" || own === PRESENTER_BADGE_TYPE ? FACULTY_BADGE : current;
}

export async function makeRegistrationFaculty(input: MakeFacultyInput): Promise<MakeFacultyResult> {
  const { eventId, registrationId } = input;
  const refuse = (code: MakeFacultyErrorCode, message: string, plan?: MakeFacultyPlan): MakeFacultyResult => {
    // A preview that asks for the confirmation is the dialog doing its job, not a refusal worth a warning.
    const level = code === "CONFIRM_WAIVE" ? "info" : "warn";
    apiLogger[level]({ msg: "make-faculty:refused", eventId, registrationId, code, userId: input.actorUserId });
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
    const alreadyOnFaculty = row.ticketType?.isFaculty === true;
    // Already there AND already the organisers' doing: nothing to say or change.
    if (alreadyOnFaculty && !needsFacultyConfirmation({ onFacultyType: true, createdSource: row.createdSource, submitterSource: speaker.submitterSource })) {
      return refuse("ALREADY_FACULTY", "This registration is already Faculty, as an invited speaker.");
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

    // ── Money (P5) ──────────────────────────────────────────────────────────
    if (row.paymentStatus === PaymentStatus.INCLUSIVE) {
      return refuse("SPONSOR_PAID", "This registration is paid by a sponsor. Change its payment status on the Billing tab first.");
    }
    if (row.groupId) {
      return refuse("GROUP_MEMBER", "This registration is part of a group, which is paid as a group. Take it out of the group first.");
    }
    const paid = row.payments
      .filter((p) => p.status?.toLowerCase() === "succeeded" || p.status === "PAID")
      .reduce((sum, p) => sum + Number(p.amount), 0);
    const held = paid - Number(row.refundedAmount ?? 0);
    const paidInvoice = row.invoices.some((i) => i.status === "PAID");
    if (PAYMENT_HELD_STATUSES.includes(row.paymentStatus) || held > CENT || paidInvoice) {
      return refuse(
        "HAS_PAYMENT",
        "This registration has a payment on it. Refund it first (Billing tab: credit note, then refund); Faculty registrations carry no money.",
      );
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
    if (owing && row.stripeCheckoutSessionId) {
      return refuse("CHECKOUT_OPEN", "A card payment may be in progress on this registration. Try again when it has finished or expired.");
    }

    // Confirming a registration already on Faculty changes its mark and nothing else.
    const openInvoices = alreadyOnFaculty ? [] : row.invoices.filter((i) => (OPEN_INVOICE_STATUSES as readonly string[]).includes(i.status));
    const plan: MakeFacultyPlan = {
      registrationId: row.id,
      speaker: { id: speaker.id, name: `${speaker.firstName} ${speaker.lastName}`.trim() },
      fromType: row.ticketType?.name ?? null,
      fromRate: row.pricingTier?.name ?? null,
      owing,
      invoices: openInvoices.map((i) => ({ id: i.id, invoiceNumber: i.invoiceNumber })),
      // A registration already on Faculty keeps the badge it has.
      badge: { from: row.badgeType, to: alreadyOnFaculty ? row.badgeType : badgeAfter(row.badgeType) },
      alreadyOnFaculty,
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
    const facultyTypeId = alreadyOnFaculty ? null : await ensureFacultyTicketType(eventId);
    const moved = await updateRegistration({
      eventId,
      registrationId: row.id,
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      source: input.source,
      requestIp: input.requestIp ?? null,
      // Whoever changed it since it was read wins: nothing is moved on stale facts.
      expectedUpdatedAt: row.updatedAt.toISOString(),
      ...(facultyTypeId && { ticketTypeId: facultyTypeId }),
      toFaculty: true,
      // A fully refunded registration keeps saying so: its money history is on it.
      ...(!alreadyOnFaculty && row.paymentStatus !== PaymentStatus.REFUNDED && row.paymentStatus !== PaymentStatus.COMPLIMENTARY && { paymentStatus: PaymentStatus.COMPLIMENTARY }),
      ...(plan.badge.to !== plan.badge.from && { badgeType: plan.badge.to }),
    });
    if (!moved.ok) {
      if (moved.code === "STALE_WRITE") return refuse("STALE_WRITE", moved.message);
      apiLogger.error({ msg: "make-faculty:update-refused", eventId, registrationId, code: moved.code, detail: moved.message });
      return { ok: false, code: "UNKNOWN", message: moved.message };
    }

    // The speaker record points at its registration from here (it may have been found by address only).
    if (speaker.sourceRegistrationId !== row.id) {
      await db.speaker
        .updateMany({ where: { id: speaker.id, eventId, sourceRegistrationId: speaker.sourceRegistrationId }, data: { sourceRegistrationId: row.id } })
        .catch((err) => apiLogger.error({ err, msg: "make-faculty:speaker-link-failed", eventId, registrationId, speakerId: speaker.id }));
    }

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
