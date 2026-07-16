import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { getNextInvoiceNumber } from "@/lib/invoice-numbering";
import { generateInvoicePDF, type InvoicePDFData } from "@/lib/invoice-pdf";
import { generateReceiptPDF, type ReceiptPDFData } from "@/lib/receipt-pdf";
import { generateCreditNotePDF, type CreditNotePDFData } from "@/lib/credit-note-pdf";
import { sendEmail } from "@/lib/email";
import { getTitleLabel, deriveEventCode } from "@/lib/utils";
import { computeRegistrationFinancials, readRegistrationBasePrice, round2 } from "@/lib/registration-financials";
import {
  sendPaymentConfirmationEmail,
  paymentConfirmationRegInclude,
  INVOICE_ACCOUNTING_BCC,
  type PaymentEmailAttachment,
} from "@/lib/payment-confirmation-email";
import type { Invoice } from "@prisma/client";

// ── Shared query for building PDF data ──────────────────────────────────────

const registrationInclude = {
  attendee: {
    select: {
      firstName: true, lastName: true, email: true, organization: true, title: true,
      jobTitle: true,
    },
  },
  ticketType: { select: { name: true, price: true, currency: true } },
  pricingTier: { select: { name: true, price: true, currency: true } },
  promoCode: { select: { code: true } },
  // "Charge to another account" — when set, the invoice is addressed to
  // this payer instead of the attendee.
  billingAccount: {
    select: {
      name: true, contactName: true, email: true, phone: true,
      address: true, city: true, state: true, zipCode: true,
      country: true, taxNumber: true,
    },
  },
  event: {
    select: {
      name: true, code: true, startDate: true, venue: true, city: true,
      taxRate: true, taxLabel: true,
      bankDetails: true, supportEmail: true,
      organizationId: true,
      organization: {
        select: {
          name: true, primaryColor: true, logo: true,
          companyName: true, companyAddress: true, companyCity: true,
          companyState: true, companyZipCode: true, companyCountry: true,
          companyPhone: true, companyEmail: true, taxId: true,
        },
      },
    },
  },
} as const;

// ── Event-code resolution ──────────────────────────────────────────────────

/**
 * Resolve the short event code used as the prefix on invoice / receipt /
 * credit-note numbers (e.g., `HFC2026-INV-001`).
 *
 * Prefers the admin-set `event.code`. Falls back to `deriveEventCode` from
 * `src/lib/utils.ts` — the same helper that auto-populates `event.code` on
 * new event creation (both REST `POST /api/events` and MCP `create_event`).
 *
 * The fallback only fires for **legacy events** that predate the auto-
 * derivation at creation, or events created via paths that bypassed it
 * (seed data, direct DB inserts). When that happens we backfill
 * `event.code` on the row so subsequent invoices for the same event use
 * the stable prefix and don't re-derive on every call.
 *
 * We no longer throw here: the previous throw silently killed the Stripe
 * webhook's fire-and-forget receipt creation, which meant registrants
 * clicked "View Invoice" and got a `quote.json` downloaded (JSON error
 * served by the fallback /quote route).
 */
async function resolveEventCode(
  event: { id: string; code: string | null; name: string },
  context: { registrationId: string; flow: "INVOICE" | "RECEIPT" | "CREDIT_NOTE" },
): Promise<string> {
  if (event.code) return event.code;

  const fallback = deriveEventCode(event.name);
  apiLogger.warn({
    msg: "invoice-service:event-code-missing-backfilling",
    eventId: event.id,
    registrationId: context.registrationId,
    flow: context.flow,
    derivedCode: fallback,
    hint: "Legacy event — code backfilled to stabilize invoice numbering. Set a custom code in Event Settings if preferred.",
  });

  // Fire-and-forget backfill. If two webhook retries race here both derive
  // the same deterministic value, so the result is idempotent. Errors are
  // logged but must not block the invoice creation that's about to run.
  db.event
    .updateMany({
      where: { id: event.id, code: null },
      data: { code: fallback },
    })
    .catch((err) =>
      apiLogger.error({ err, eventId: event.id }, "invoice-service:event-code-backfill-failed"),
    );

  return fallback;
}

// ── Shared pricing calculation ─────────────────────────────────────────────

function calcInvoicePricing(registration: {
  pricingTier?: { price: unknown; currency: string } | null;
  ticketType: { price: unknown; currency: string } | null;
  discountAmount?: unknown;
  promoCode?: { code: string } | null;
  event: { taxRate: unknown; taxLabel: string | null };
}) {
  const price = readRegistrationBasePrice(registration);
  const currency = registration.pricingTier?.currency ?? registration.ticketType?.currency ?? "USD";
  const discountCode = registration.promoCode?.code || null;
  const taxRate = registration.event.taxRate ? Number(registration.event.taxRate) : null;
  // Delegate the math to the ONE shared totals implementation (review M9) —
  // this used to be a fourth, UNROUNDED copy of the formula, so the credit-
  // note cap (fed from here) and the refund remaining (fed from
  // computeRegistrationFinancials) could disagree at the cent boundary.
  const fin = computeRegistrationFinancials({
    subtotal: price,
    discount: registration.discountAmount ? Number(registration.discountAmount) : 0,
    taxRate,
    taxLabel: registration.event.taxLabel,
    currency,
    totalPaid: 0,
  });
  return {
    price,
    currency,
    discount: fin.discount,
    discountCode,
    discountedPrice: fin.taxableBase,
    taxRate,
    taxAmount: fin.taxAmount,
    total: fin.total,
  };
}

// ── Captured-amount reconciliation (review M5) ─────────────────────────────
/**
 * A PAID document must state what was actually CHARGED, not today's computed
 * pricing. Checkout sessions live ~24h at a frozen price and admin invoices
 * can pre-date a reprice — so when the captured Payment.amount diverges from
 * the computed total, scale the components to the captured amount and
 * reconcile the last component (tax) so the pieces sum exactly (the same
 * pattern createCreditNote uses). Within a cent → unchanged.
 */
function reconcileComponentsToCaptured(
  components: { price: number; discount: number; taxAmount: number; total: number },
  capturedTotal: number | null | undefined,
  logCtx: { registrationId: string; flow: string },
): { price: number; discount: number; taxAmount: number; total: number; reconciled: boolean } {
  if (capturedTotal == null || Math.abs(capturedTotal - components.total) <= 0.005) {
    return { ...components, reconciled: false };
  }
  let next: { price: number; discount: number; taxAmount: number; total: number };
  if (components.total <= 0.005) {
    // Computed total is zero (legacy/odd rows) — nothing to scale; the whole
    // captured amount becomes the line.
    next = { price: round2(capturedTotal), discount: 0, taxAmount: 0, total: round2(capturedTotal) };
  } else {
    const ratio = capturedTotal / components.total;
    const price = round2(components.price * ratio);
    const discount = round2(components.discount * ratio);
    const taxAmount = round2(capturedTotal - (price - discount));
    next = { price, discount, taxAmount, total: round2(capturedTotal) };
  }
  apiLogger.warn({
    msg: "paid-doc:re-totaled-to-captured-amount",
    ...logCtx,
    computedTotal: components.total,
    capturedTotal,
  });
  return { ...next, reconciled: true };
}

// ── Create Invoice ──────────────────────────────────────────────────────────

export async function createInvoice(params: {
  registrationId: string;
  eventId: string;
  organizationId: string;
  dueDate?: Date;
}): Promise<Invoice> {
  const { registrationId, eventId, organizationId, dueDate } = params;

  // The registration is BOUND to the caller's event + org in the same query
  // (review H9): a body-supplied registrationId from another event — or
  // another org — must never mint an invoice under this event's numbering or
  // leak its attendee into this org's invoice list.
  const registration = await db.registration.findFirstOrThrow({
    where: { id: registrationId, eventId, event: { organizationId } },
    include: registrationInclude,
  });

  const { price, currency, discount, discountCode, taxRate, taxAmount, total } = calcInvoicePricing(registration);
  const eventCode = await resolveEventCode(
    { id: eventId, code: registration.event.code, name: registration.event.name },
    { registrationId, flow: "INVOICE" },
  );

  const invoice = await db.$transaction(async (tx: Prisma.TransactionClient) => {
    const { sequenceNumber, invoiceNumber } = await getNextInvoiceNumber(
      tx, eventId, "INVOICE", eventCode
    );

    return tx.invoice.create({
      data: {
        organizationId,
        eventId,
        registrationId,
        type: "INVOICE",
        invoiceNumber,
        sequenceNumber,
        status: "SENT",
        issueDate: new Date(),
        dueDate: dueDate || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
        subtotal: price,
        discountCode,
        discountAmount: discount,
        taxRate,
        taxLabel: registration.event.taxLabel || "VAT",
        taxAmount,
        total,
        currency,
      },
    });
  });

  apiLogger.info({ msg: "Invoice created", invoiceNumber: invoice.invoiceNumber, registrationId, total: Number(invoice.total), currency });
  return invoice;
}

// ── Create Receipt ──────────────────────────────────────────────────────────

/**
 * Creates (or promotes) the post-payment Invoice row. The caller is the
 * Stripe webhook on `payment_intent.succeeded` / `checkout.session.completed`.
 *
 * Naming note: our system's post-payment artifact is now the **INVOICE**
 * (status=PAID). Stripe sends its own receipt email separately — we no
 * longer emit a RECEIPT document. Legacy RECEIPT rows remain in the DB
 * and render via the legacy receipt-pdf renderer.
 *
 * Behavior:
 *   - If an existing admin-created INVOICE row exists for this registration,
 *     update it in-place (status → PAID, paidDate, paymentMethod, etc.).
 *     Prevents duplicate-invoice numbering.
 *   - Otherwise mint a new INVOICE with status PAID.
 */
export async function createPaidInvoice(params: {
  registrationId: string;
  eventId: string;
  organizationId: string;
  paymentId: string;
  paymentMethod?: string;
  paymentReference?: string;
  paidAt?: Date;
  /** The amount actually CAPTURED (Payment.amount). When it diverges from the
   *  computed pricing (stale checkout session, pre-reprice admin invoice) the
   *  PAID document is re-totaled to it (review M5). */
  capturedTotal?: number | null;
}): Promise<Invoice> {
  const {
    registrationId,
    eventId,
    organizationId,
    paymentId,
    paymentMethod,
    paymentReference,
    paidAt,
    capturedTotal,
  } = params;

  const registration = await db.registration.findUniqueOrThrow({
    where: { id: registrationId },
    include: registrationInclude,
  });

  const pricing = calcInvoicePricing(registration);
  const { currency, discountCode, taxRate } = pricing;
  const { price, discount, taxAmount, total } = reconcileComponentsToCaptured(
    pricing, capturedTotal, { registrationId, flow: "INVOICE" },
  );
  const eventCode = await resolveEventCode(
    { id: eventId, code: registration.event.code, name: registration.event.name },
    { registrationId, flow: "INVOICE" },
  );

  const paid = paidAt ?? new Date();

  const invoice = await db.$transaction(async (tx: Prisma.TransactionClient) => {
    // Serialize concurrent minters on the registration ROW (review M1): the
    // Stripe webhook's detached block, the reconciliation worker, and manual
    // capture can all reach here at once — without the lock both findFirst
    // checks see nothing and two PAID invoices (+ two emails) mint. Same
    // FOR UPDATE pattern createCreditNote uses; holds through pgbouncer
    // inside an interactive transaction.
    await tx.$queryRaw`SELECT id FROM "Registration" WHERE id = ${registrationId} FOR UPDATE`;

    // Reuse-or-promote (idempotent): a registration gets exactly ONE INVOICE.
    //   - already PAID (webhook retry / reconciliation re-run) → return as-is
    //     so we never mint a duplicate PAID invoice number.
    //   - admin pre-created (SENT/DRAFT/OVERDUE) → promote to PAID in place.
    //   - none → mint a new PAID invoice below.
    const existing = await tx.invoice.findFirst({
      where: {
        registrationId,
        type: "INVOICE",
        status: { in: ["DRAFT", "SENT", "OVERDUE", "PAID"] },
      },
      orderBy: { createdAt: "desc" },
    });

    if (existing) {
      if (existing.status === "PAID") return existing;
      // Promote in place — and re-total the STORED components when the
      // captured amount diverges (review M5: a pre-created SENT invoice at
      // $500 promoted after a $400 discounted payment used to keep saying
      // $500 on the emailed PAID document).
      const promoteFigures =
        capturedTotal != null && Math.abs(Number(existing.total) - capturedTotal) > 0.005
          ? { subtotal: price, discountAmount: discount, taxAmount, total }
          : {};
      if ("total" in promoteFigures) {
        apiLogger.warn({
          msg: "paid-doc:promoted-invoice-re-totaled",
          registrationId,
          invoiceId: existing.id,
          storedTotal: Number(existing.total),
          capturedTotal,
        });
      }
      return tx.invoice.update({
        where: { id: existing.id },
        data: {
          status: "PAID",
          paidDate: paid,
          paymentId,
          paymentMethod: paymentMethod || "stripe",
          paymentReference,
          ...promoteFigures,
        },
      });
    }

    const { sequenceNumber, invoiceNumber } = await getNextInvoiceNumber(
      tx, eventId, "INVOICE", eventCode
    );

    return tx.invoice.create({
      data: {
        organizationId,
        eventId,
        registrationId,
        paymentId,
        type: "INVOICE",
        invoiceNumber,
        sequenceNumber,
        status: "PAID",
        issueDate: new Date(),
        paidDate: paid,
        subtotal: price,
        discountCode,
        discountAmount: discount,
        taxRate,
        taxLabel: registration.event.taxLabel || "VAT",
        taxAmount,
        total,
        currency,
        paymentMethod: paymentMethod || "stripe",
        paymentReference,
      },
    });
  });

  apiLogger.info({
    msg: "Paid invoice created",
    invoiceNumber: invoice.invoiceNumber,
    registrationId,
    total: Number(invoice.total),
    currency,
  });
  return invoice;
}

// ── Create Receipt ────────────────────────────────────────────────────────────

/**
 * Mint the post-payment RECEIPT document — the proof-of-payment artifact that
 * finance wants issued alongside the invoice. Distinct from the invoice (the
 * demand): the receipt is numbered on its own per-event sequence (`…-REC-001`)
 * and links back to the paid invoice via `parentInvoiceId` for traceability.
 *
 * Idempotent: a registration gets exactly ONE receipt. Returns the existing one
 * with `created: false` on a webhook retry / reconciliation re-run (mirrors
 * `createCreditNote`) so the caller can skip re-emailing.
 *
 * Only ever called for registrations that actually paid (Stripe / manual /
 * reconciliation) — comp / free / INCLUSIVE registrations never get a receipt.
 */
export async function createPaidReceipt(params: {
  registrationId: string;
  eventId: string;
  organizationId: string;
  parentInvoiceId?: string;
  paymentMethod?: string;
  paymentReference?: string;
  paidAt?: Date;
  /** The amount actually CAPTURED (Payment.amount) — see createPaidInvoice. */
  capturedTotal?: number | null;
}): Promise<{ receipt: Invoice; created: boolean }> {
  const {
    registrationId,
    eventId,
    organizationId,
    parentInvoiceId,
    paymentMethod,
    paymentReference,
    paidAt,
    capturedTotal,
  } = params;

  const registration = await db.registration.findUniqueOrThrow({
    where: { id: registrationId },
    include: registrationInclude,
  });

  const pricing = calcInvoicePricing(registration);
  const { currency, discountCode, taxRate } = pricing;
  const { price, discount, taxAmount, total } = reconcileComponentsToCaptured(
    pricing, capturedTotal, { registrationId, flow: "RECEIPT" },
  );
  const eventCode = await resolveEventCode(
    { id: eventId, code: registration.event.code, name: registration.event.name },
    { registrationId, flow: "RECEIPT" },
  );

  const paid = paidAt ?? new Date();

  let created = true;
  const receipt = await db.$transaction(async (tx: Prisma.TransactionClient) => {
    // Row-lock + in-tx existence check (review M1): the check used to run
    // OUTSIDE the transaction, so concurrent minters (webhook detached block
    // vs reconciliation worker vs manual capture) could each see "no receipt"
    // and double-mint + double-email.
    await tx.$queryRaw`SELECT id FROM "Registration" WHERE id = ${registrationId} FOR UPDATE`;
    const existing = await tx.invoice.findFirst({
      where: { registrationId, type: "RECEIPT" },
      orderBy: { createdAt: "desc" },
    });
    if (existing) {
      apiLogger.info({
        msg: "Receipt already exists for registration; returning existing (idempotent)",
        invoiceNumber: existing.invoiceNumber,
        registrationId,
      });
      created = false;
      return existing;
    }

    const { sequenceNumber, invoiceNumber } = await getNextInvoiceNumber(
      tx, eventId, "RECEIPT", eventCode
    );
    return tx.invoice.create({
      data: {
        organizationId,
        eventId,
        registrationId,
        // NOTE: `Invoice.paymentId` is @unique (1:1 Payment↔Invoice, owned by
        // the INVOICE row). The receipt must NOT set it or it collides with the
        // paid invoice's row — it traces to the payment via `parentInvoiceId`.
        parentInvoiceId,
        type: "RECEIPT",
        invoiceNumber,
        sequenceNumber,
        status: "PAID",
        issueDate: new Date(),
        paidDate: paid,
        subtotal: price,
        discountCode,
        discountAmount: discount,
        taxRate,
        taxLabel: registration.event.taxLabel || "VAT",
        taxAmount,
        total,
        currency,
        paymentMethod: paymentMethod || "stripe",
        paymentReference,
      },
    });
  });

  if (created) {
    apiLogger.info({
      msg: "Receipt created",
      invoiceNumber: receipt.invoiceNumber,
      registrationId,
      total: Number(receipt.total),
      currency,
    });
  }
  return { receipt, created };
}

// ── Create Credit Note ──────────────────────────────────────────────────────

/**
 * Discriminable error thrown by `createCreditNote` when the requested amount is
 * invalid. Callers (the Issue-Credit-Note route) map `code` to a 400 with the
 * `meta` figures so the organizer sees what's left to credit.
 */
export class CreditNoteAmountError extends Error {
  code: "INVALID_AMOUNT" | "CREDIT_LIMIT_EXCEEDED";
  meta: { paidTotal: number; creditedBefore: number; outstanding: number; currency: string };
  constructor(
    code: "INVALID_AMOUNT" | "CREDIT_LIMIT_EXCEEDED",
    message: string,
    meta: { paidTotal: number; creditedBefore: number; outstanding: number; currency: string },
  ) {
    super(message);
    this.name = "CreditNoteAmountError";
    this.code = code;
    this.meta = meta;
  }
}

// round2 comes from registration-financials (review M9 — one shared copy).

/**
 * Issue a credit note for a registration — full OR partial. Multiple credit
 * notes per registration are allowed (each partial refund can carry its own),
 * capped so the sum of non-cancelled credit notes never exceeds the paid total.
 *
 * `amount` defaults to the full outstanding (paid total − already credited). A
 * partial amount scales the frozen subtotal/discount/tax proportionally so the
 * credit-note PDF stays internally consistent (subtotal + tax = total).
 *
 * NOT idempotent (multiple are legal). Duplicate protection for the automatic
 * `charge.refunded` path lives in the webhook, which claims the refund delta
 * before calling this. Returns the running credited figures so callers can
 * reflect "credited X of Y".
 */
export async function createCreditNote(params: {
  registrationId: string;
  eventId: string;
  organizationId: string;
  originalInvoiceId?: string;
  reason?: string;
  /** Partial credit-note amount (tax-inclusive). Omit for the full outstanding. */
  amount?: number;
}): Promise<{ invoice: Invoice; created: boolean; creditedBefore: number; creditedAfter: number; paidTotal: number }> {
  const { registrationId, eventId, organizationId, originalInvoiceId, reason, amount } = params;

  const registration = await db.registration.findUniqueOrThrow({
    where: { id: registrationId },
    include: registrationInclude,
  });

  const { price, currency, discount, discountCode, taxRate, total: fullTotal } =
    calcInvoicePricing(registration);

  const eventCode = await resolveEventCode(
    { id: eventId, code: registration.event.code, name: registration.event.name },
    { registrationId, flow: "CREDIT_NOTE" },
  );

  // Find the original invoice if not provided
  let parentId = originalInvoiceId;
  if (!parentId) {
    const existingInvoice = await db.invoice.findFirst({
      where: { registrationId, type: "INVOICE" },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    parentId = existingInvoice?.id || undefined;
  }

  // The whole cap check + create runs inside ONE transaction under a row lock on
  // the registration, so two concurrent Issue-Credit-Note calls (double-click, or
  // organizer + webhook) serialize — the sum-of-existing-credit-notes cap is
  // re-read after the lock, so they can never both slip past it and over-credit.
  const { creditNote, creditedBefore, amt, collectedTotal } = await db.$transaction(async (tx: Prisma.TransactionClient) => {
    // Serialize concurrent credit-note issues for this registration. The lock is
    // held for the duration of the tx (works through the pgbouncer transaction
    // pooler — single backend per tx), same pattern as updateEventSettings.
    await tx.$queryRaw`SELECT id FROM "Registration" WHERE id = ${registrationId} FOR UPDATE`;

    // ONE source of truth for "what was collected" (July-7 review M1 + July-8
    // M3): Σ settled payments when Payment rows exist, else the computed
    // registration total — the SAME rule refundRegistration uses for its
    // `paidTotal`. Before this, the CN cap used computed CURRENT pricing while
    // the refund capped against captured payments, so a post-payment re-tier /
    // re-price made the credit-note document and the refundable amount
    // disagree (and cancel-with-refund minted a CN for a different figure than
    // it refunded). Read inside the lock, alongside the credited sum.
    const settled = await tx.payment.findMany({
      where: { registrationId, status: { in: ["PAID", "REFUNDED"] } },
      select: { amount: true },
    });
    const collectedTotal = settled.length
      ? round2(settled.reduce((s, p) => s + Number(p.amount), 0))
      : fullTotal;

    // Re-read the already-credited sum INSIDE the lock to cap the total.
    const existingCns = await tx.invoice.findMany({
      where: { registrationId, type: "CREDIT_NOTE", status: { not: "CANCELLED" } },
      select: { total: true },
    });
    const creditedBefore = round2(existingCns.reduce((s, c) => s + Number(c.total), 0));
    const outstanding = round2(collectedTotal - creditedBefore);

    const amt = amount != null ? round2(amount) : outstanding;
    if (amt <= 0) {
      throw new CreditNoteAmountError(
        "INVALID_AMOUNT",
        "Credit note amount must be greater than zero.",
        { paidTotal: collectedTotal, creditedBefore, outstanding, currency },
      );
    }
    if (amt > outstanding + 0.005) {
      throw new CreditNoteAmountError(
        "CREDIT_LIMIT_EXCEEDED",
        `Credit note amount ${currency} ${amt.toFixed(2)} exceeds the outstanding ${currency} ${outstanding.toFixed(2)}.`,
        { paidTotal: collectedTotal, creditedBefore, outstanding, currency },
      );
    }

    // Scale the frozen pricing components proportionally for a partial credit.
    // Reconcile the last component (tax) to the remainder so subtotal − discount
    // + tax === total to the cent, even when independent rounding would drift.
    // The ratio denominator stays the COMPUTED total — components describe the
    // pricing breakdown, so a CN for collected-money that diverges from current
    // pricing still carries proportionally consistent subtotal/discount/tax.
    const ratio = fullTotal > 0 ? amt / fullTotal : 0;
    const cnSubtotal = round2(price * ratio);
    const cnDiscount = round2(discount * ratio);
    const cnTax = round2(amt - (cnSubtotal - cnDiscount));
    // "Covers full" = the running credited total now covers everything
    // collected (was `amt >= fullTotal`, which both used the wrong base AND
    // ignored prior partial credits — two 50% CNs never flipped the parent).
    const coversFull = round2(creditedBefore + amt) >= collectedTotal - 0.005;

    const { sequenceNumber, invoiceNumber } = await getNextInvoiceNumber(
      tx, eventId, "CREDIT_NOTE", eventCode
    );

    // Mark the original invoice REFUNDED only when this credit note covers the
    // full amount — a partial credit note leaves the invoice intact.
    if (parentId && coversFull) {
      await tx.invoice.update({
        where: { id: parentId },
        data: { status: "REFUNDED" },
      });
    }

    const creditNote = await tx.invoice.create({
      data: {
        organizationId,
        eventId,
        registrationId,
        type: "CREDIT_NOTE",
        invoiceNumber,
        sequenceNumber,
        status: "REFUNDED",
        issueDate: new Date(),
        subtotal: cnSubtotal,
        discountCode,
        discountAmount: cnDiscount,
        taxRate,
        taxLabel: registration.event.taxLabel || "VAT",
        taxAmount: cnTax,
        total: amt,
        currency,
        parentInvoiceId: parentId,
        notes: reason || (coversFull ? "Full refund" : `Partial credit ${currency} ${amt.toFixed(2)}`),
      },
    });
    return { creditNote, creditedBefore, amt, collectedTotal };
  });

  const creditedAfter = round2(creditedBefore + amt);
  apiLogger.info({
    msg: "Credit note created",
    invoiceNumber: creditNote.invoiceNumber,
    registrationId,
    amount: amt,
    creditedAfter,
    paidTotal: collectedTotal,
    currency,
  });
  return { invoice: creditNote, created: true, creditedBefore, creditedAfter, paidTotal: collectedTotal };
}

// ── Generate PDF ────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildPDFFromLoadedInvoice(invoice: any): Promise<Buffer> {
  const reg = invoice.registration;
  const org = reg.event.organization;
  const titleLabel = getTitleLabel(reg.attendee.title);

  if (invoice.type === "RECEIPT") {
    const receiptData: ReceiptPDFData = {
      receiptNumber: invoice.invoiceNumber,
      paymentDate: invoice.paidDate || invoice.issueDate,
      paymentMethod: invoice.paymentMethod,
      paymentReference: invoice.paymentReference,
      orgName: org.name,
      companyName: org.companyName,
      companyAddress: org.companyAddress,
      companyCity: org.companyCity,
      companyState: org.companyState,
      companyZipCode: org.companyZipCode,
      companyCountry: org.companyCountry,
      taxId: org.taxId,
      primaryColor: org.primaryColor,
      firstName: reg.attendee.firstName,
      lastName: reg.attendee.lastName,
      email: reg.attendee.email,
      organization: reg.attendee.organization,
      title: titleLabel || null,
      eventName: reg.event.name,
      eventDate: reg.event.startDate,
      eventVenue: reg.event.venue,
      eventCity: reg.event.city,
      registrationType: reg.ticketType?.name ?? "General",
      pricingTier: reg.pricingTier?.name || null,
      price: Number(invoice.subtotal),
      // Stored, reconciled figures — the PDF prints these, never recomputes
      // (review M10).
      taxAmount: invoice.taxAmount != null ? Number(invoice.taxAmount) : null,
      total: invoice.total != null ? Number(invoice.total) : null,
      currency: invoice.currency,
      taxRate: invoice.taxRate ? Number(invoice.taxRate) : null,
      taxLabel: invoice.taxLabel || "VAT",
      discountCode: invoice.discountCode || null,
      discountAmount: Number(invoice.discountAmount) || 0,
    };
    return generateReceiptPDF(receiptData);
  }

  if (invoice.type === "CREDIT_NOTE") {
    const cnData: CreditNotePDFData = {
      creditNoteNumber: invoice.invoiceNumber,
      issueDate: invoice.issueDate,
      originalInvoiceNumber: invoice.parentInvoice?.invoiceNumber || null,
      logoPath: org.logo,
      orgName: org.name,
      companyName: org.companyName,
      companyAddress: org.companyAddress,
      companyCity: org.companyCity,
      companyState: org.companyState,
      companyZipCode: org.companyZipCode,
      companyCountry: org.companyCountry,
      taxId: org.taxId,
      primaryColor: org.primaryColor,
      firstName: reg.attendee.firstName,
      lastName: reg.attendee.lastName,
      email: reg.attendee.email,
      organization: reg.attendee.organization,
      title: titleLabel || null,
      eventName: reg.event.name,
      eventDate: reg.event.startDate,
      eventVenue: reg.event.venue,
      eventCity: reg.event.city,
      registrationType: reg.ticketType?.name ?? "General",
      pricingTier: reg.pricingTier?.name || null,
      price: Number(invoice.subtotal),
      // Stored, reconciled figures — the PDF prints these, never recomputes
      // (review M10).
      taxAmount: invoice.taxAmount != null ? Number(invoice.taxAmount) : null,
      total: invoice.total != null ? Number(invoice.total) : null,
      currency: invoice.currency,
      taxRate: invoice.taxRate ? Number(invoice.taxRate) : null,
      taxLabel: invoice.taxLabel || "VAT",
      discountCode: invoice.discountCode || null,
      discountAmount: Number(invoice.discountAmount) || 0,
      notes: invoice.notes,
    };
    return generateCreditNotePDF(cnData);
  }

  // Default: INVOICE (pre-payment = SENT/DRAFT, post-payment = PAID).
  // When the linked Payment row is loaded (see `payment` include on the
  // loader callers), we pass its card/settlement fields through so the
  // Payment Received block on paid PDFs shows "Visa ending 4242".
  const payment = invoice.payment as
    | {
        cardBrand?: string | null;
        cardLast4?: string | null;
        paymentMethodType?: string | null;
        paidAt?: Date | null;
        stripePaymentId?: string | null;
      }
    | null
    | undefined;
  const invoiceData: InvoicePDFData = {
    invoiceNumber: invoice.invoiceNumber,
    issueDate: invoice.issueDate,
    dueDate: invoice.dueDate,
    status: invoice.status,
    isTaxInvoice: !!org.taxId,
    orgName: org.name,
    companyName: org.companyName,
    companyAddress: org.companyAddress,
    companyCity: org.companyCity,
    companyState: org.companyState,
    companyZipCode: org.companyZipCode,
    companyCountry: org.companyCountry,
    companyPhone: org.companyPhone,
    companyEmail: org.companyEmail,
    taxId: org.taxId,
    primaryColor: org.primaryColor,
    logoPath: org.logo,
    firstName: reg.attendee.firstName,
    lastName: reg.attendee.lastName,
    email: reg.attendee.email,
    organization: reg.attendee.organization,
    title: titleLabel || null,
    jobTitle: reg.attendee.jobTitle,
    billingAddress: reg.billingAddress,
    billingCity: reg.billingCity,
    billingState: reg.billingState,
    billingZipCode: reg.billingZipCode,
    billingCountry: reg.billingCountry,
    taxNumber: reg.taxNumber,
    payer: reg.billingAccount
      ? {
          name: reg.billingAccount.name,
          contactName: reg.billingAccount.contactName,
          email: reg.billingAccount.email,
          phone: reg.billingAccount.phone,
          address: reg.billingAccount.address,
          city: reg.billingAccount.city,
          state: reg.billingAccount.state,
          zipCode: reg.billingAccount.zipCode,
          country: reg.billingAccount.country,
          taxNumber: reg.billingAccount.taxNumber,
          reference: reg.payerReference,
        }
      : null,
    eventName: reg.event.name,
    eventDate: reg.event.startDate,
    eventVenue: reg.event.venue,
    eventCity: reg.event.city,
    registrationType: reg.ticketType?.name ?? "General",
    pricingTier: reg.pricingTier?.name || null,
    price: Number(invoice.subtotal),
    // Stored, reconciled figures — the PDF prints these, never recomputes
    // (review M10).
    taxAmount: invoice.taxAmount != null ? Number(invoice.taxAmount) : null,
    total: invoice.total != null ? Number(invoice.total) : null,
    currency: invoice.currency,
    taxRate: invoice.taxRate ? Number(invoice.taxRate) : null,
    taxLabel: invoice.taxLabel || "VAT",
    discountCode: invoice.discountCode || null,
    discountAmount: Number(invoice.discountAmount) || 0,
    bankDetails: reg.event.bankDetails,
    supportEmail: reg.event.supportEmail,
    paymentMethodType: payment?.paymentMethodType ?? invoice.paymentMethod ?? null,
    cardBrand: payment?.cardBrand ?? null,
    cardLast4: payment?.cardLast4 ?? null,
    paidAt: payment?.paidAt ?? invoice.paidDate ?? null,
    paymentReference: payment?.stripePaymentId ?? invoice.paymentReference ?? null,
  };
  return generateInvoicePDF(invoiceData);
}

export async function generatePDFForInvoice(invoiceId: string): Promise<Buffer> {
  const invoice = await db.invoice.findUniqueOrThrow({
    where: { id: invoiceId },
    include: {
      registration: { include: registrationInclude },
      parentInvoice: { select: { invoiceNumber: true } },
      // `payment` carries the card details (brand, last4, settle time) we
      // render on the paid-invoice PDF's "Payment Received" block. Null for
      // admin-created-then-not-yet-paid INVOICEs.
      payment: {
        select: {
          cardBrand: true,
          cardLast4: true,
          paymentMethodType: true,
          paidAt: true,
          stripePaymentId: true,
        },
      },
    },
  });

  return buildPDFFromLoadedInvoice(invoice);
}

// ── Send Invoice Email ──────────────────────────────────────────────────────

export async function sendInvoiceEmail(invoiceId: string): Promise<void> {
  // Single query: fetch invoice + minimal registration data + full data for PDF in one go
  const invoice = await db.invoice.findUniqueOrThrow({
    where: { id: invoiceId },
    include: {
      registration: {
        include: {
          ...registrationInclude,
          event: {
            select: {
              ...registrationInclude.event.select,
              emailFromAddress: true,
              emailFromName: true,
            },
          },
        },
      },
      parentInvoice: { select: { invoiceNumber: true } },
      payment: {
        select: {
          cardBrand: true,
          cardLast4: true,
          paymentMethodType: true,
          paidAt: true,
          stripePaymentId: true,
        },
      },
    },
  });

  const reg = invoice.registration;
  const { attendee, event } = reg;
  const pdfBuffer = await buildPDFFromLoadedInvoice(invoice);

  const typeLabels: Record<string, string> = {
    INVOICE: "Invoice",
    RECEIPT: "Payment Receipt",
    CREDIT_NOTE: "Credit Note",
  };
  const typeLabel = typeLabels[invoice.type] || "Document";

  const subject = `${typeLabel} ${invoice.invoiceNumber} — ${event.name}`;
  const htmlContent = buildInvoiceEmailHtml(typeLabel, invoice.invoiceNumber, event.name, attendee.firstName);

  await sendEmail({
    to: [{ email: attendee.email, name: `${attendee.firstName} ${attendee.lastName}` }],
    bcc: INVOICE_ACCOUNTING_BCC,
    subject,
    htmlContent,
    from: event.emailFromAddress
      ? { email: event.emailFromAddress, name: event.emailFromName || event.name }
      : undefined,
    attachments: [{
      name: `${invoice.invoiceNumber}.pdf`,
      content: pdfBuffer.toString("base64"),
      contentType: "application/pdf",
    }],
    emailType: `invoice_${invoice.type.toLowerCase()}`,
    stream: "transactional",
    logContext: {
      organizationId: invoice.organizationId,
      eventId: invoice.eventId,
      entityType: "REGISTRATION",
      entityId: invoice.registrationId,
      templateSlug: `invoice-${invoice.type.toLowerCase()}`,
    },
  });

  await db.invoice.update({
    where: { id: invoiceId },
    data: { sentAt: new Date(), sentTo: attendee.email },
  });

  apiLogger.info({ msg: "Invoice email sent", invoiceId, invoiceNumber: invoice.invoiceNumber, to: attendee.email });
}

function buildInvoiceEmailHtml(typeLabel: string, invoiceNumber: string, eventName: string, firstName: string): string {
  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h2 style="color: #1e293b; margin-bottom: 8px;">${typeLabel} ${invoiceNumber}</h2>
      <p style="color: #475569; font-size: 14px;">
        Dear ${firstName},
      </p>
      <p style="color: #475569; font-size: 14px;">
        Please find your ${typeLabel.toLowerCase()} for <strong>${eventName}</strong> attached to this email as a PDF.
      </p>
      <p style="color: #475569; font-size: 14px;">
        If you have any questions regarding this document, please do not hesitate to contact us.
      </p>
      <p style="color: #94a3b8; font-size: 12px; margin-top: 30px;">
        This is an automated message. The ${typeLabel.toLowerCase()} is attached as a PDF document.
      </p>
    </div>
  `;
}

// ── Combined post-payment documents email ────────────────────────────────────

/**
 * Send ONE "payment received" email carrying BOTH the paid invoice PDF and the
 * receipt PDF (plus Stripe's hosted-receipt link when present). This is the
 * single post-payment message — it replaces the previously-separate payment-
 * confirmation and invoice emails. Marks both documents as sent.
 */
export async function sendPaymentDocumentsEmail(params: {
  registrationId: string;
  invoice: Invoice;
  receipt: Invoice;
  amount: number;
  currency: string;
  receiptUrl?: string | null;
  paymentReference?: string | null;
}): Promise<void> {
  const { registrationId, invoice, receipt, amount, currency, receiptUrl, paymentReference } = params;

  // Build both PDFs (generatePDFForInvoice branches on type → invoice vs receipt).
  const [invoicePdf, receiptPdf] = await Promise.all([
    generatePDFForInvoice(invoice.id),
    generatePDFForInvoice(receipt.id),
  ]);
  const attachments: PaymentEmailAttachment[] = [
    { name: `${invoice.invoiceNumber}.pdf`, content: invoicePdf.toString("base64"), contentType: "application/pdf" },
    { name: `${receipt.invoiceNumber}.pdf`, content: receiptPdf.toString("base64"), contentType: "application/pdf" },
  ];

  const registration = await db.registration.findUniqueOrThrow({
    where: { id: registrationId },
    include: paymentConfirmationRegInclude,
  });

  await sendPaymentConfirmationEmail(
    registration,
    amount,
    currency,
    receiptUrl ?? null,
    paymentReference ?? null,
    attachments,
  );

  const sentAt = new Date();
  await db.invoice.updateMany({
    where: { id: { in: [invoice.id, receipt.id] } },
    data: { sentAt, sentTo: registration.attendee.email },
  });
}

/**
 * The single post-payment fan-out used by ALL payment channels (Stripe webhook,
 * manual/offline capture, reconciliation): mint the PAID invoice + the receipt,
 * then send one combined email carrying both PDFs. Idempotent end-to-end
 * (`createPaidInvoice` + `createPaidReceipt` both reuse existing rows), so a
 * webhook retry or reconciliation re-run won't duplicate documents.
 */
export async function issuePaidRegistrationDocuments(params: {
  registrationId: string;
  eventId: string;
  organizationId: string;
  paymentId: string;
  paymentMethod?: string;
  paymentReference?: string;
  paidAt?: Date;
  amount: number;
  currency: string;
  receiptUrl?: string | null;
}): Promise<{ invoice: Invoice; receipt: Invoice }> {
  const {
    registrationId, eventId, organizationId, paymentId,
    paymentMethod, paymentReference, paidAt, amount, currency, receiptUrl,
  } = params;

  const invoice = await createPaidInvoice({
    registrationId, eventId, organizationId, paymentId, paymentMethod, paymentReference, paidAt,
    // The PAID documents state what was actually captured (review M5).
    capturedTotal: amount,
  });
  const { receipt } = await createPaidReceipt({
    registrationId, eventId, organizationId,
    parentInvoiceId: invoice.id, paymentMethod, paymentReference, paidAt,
    capturedTotal: amount,
  });

  await sendPaymentDocumentsEmail({
    registrationId, invoice, receipt, amount, currency, receiptUrl, paymentReference,
  });

  return { invoice, receipt };
}

// ── Cancel Invoice ──────────────────────────────────────────────────────────

export async function cancelInvoice(invoiceId: string): Promise<Invoice> {
  const existing = await db.invoice.findUniqueOrThrow({
    where: { id: invoiceId },
    select: { id: true, status: true, invoiceNumber: true },
  });

  if (existing.status === "CANCELLED") {
    apiLogger.warn({ msg: "Invoice already cancelled", invoiceId, invoiceNumber: existing.invoiceNumber });
    return db.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
  }

  const cancelled = await db.invoice.update({
    where: { id: invoiceId },
    data: { status: "CANCELLED" },
  });

  apiLogger.info({ msg: "Invoice cancelled", invoiceId, invoiceNumber: cancelled.invoiceNumber });
  return cancelled;
}
