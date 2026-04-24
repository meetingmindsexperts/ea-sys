import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { getNextInvoiceNumber } from "@/lib/invoice-numbering";
import { generateInvoicePDF, type InvoicePDFData } from "@/lib/invoice-pdf";
import { generateReceiptPDF, type ReceiptPDFData } from "@/lib/receipt-pdf";
import { generateCreditNotePDF, type CreditNotePDFData } from "@/lib/credit-note-pdf";
import { sendEmail } from "@/lib/email";
import { getTitleLabel, deriveEventCode } from "@/lib/utils";
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
  const price = Number(registration.pricingTier?.price ?? registration.ticketType?.price ?? 0);
  const currency = registration.pricingTier?.currency ?? registration.ticketType?.currency ?? "USD";
  const discount = registration.discountAmount ? Number(registration.discountAmount) : 0;
  const discountedPrice = Math.max(0, price - discount);
  const discountCode = registration.promoCode?.code || null;
  const taxRate = registration.event.taxRate ? Number(registration.event.taxRate) : null;
  const taxAmount = taxRate ? discountedPrice * (taxRate / 100) : 0;
  const total = discountedPrice + taxAmount;
  return { price, currency, discount, discountCode, discountedPrice, taxRate, taxAmount, total };
}

// ── Create Invoice ──────────────────────────────────────────────────────────

export async function createInvoice(params: {
  registrationId: string;
  eventId: string;
  organizationId: string;
  dueDate?: Date;
}): Promise<Invoice> {
  const { registrationId, eventId, organizationId, dueDate } = params;

  const registration = await db.registration.findUniqueOrThrow({
    where: { id: registrationId },
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
}): Promise<Invoice> {
  const {
    registrationId,
    eventId,
    organizationId,
    paymentId,
    paymentMethod,
    paymentReference,
    paidAt,
  } = params;

  const registration = await db.registration.findUniqueOrThrow({
    where: { id: registrationId },
    include: registrationInclude,
  });

  const { price, currency, discount, discountCode, taxRate, taxAmount, total } = calcInvoicePricing(registration);
  const eventCode = await resolveEventCode(
    { id: eventId, code: registration.event.code, name: registration.event.name },
    { registrationId, flow: "INVOICE" },
  );

  const paid = paidAt ?? new Date();

  const invoice = await db.$transaction(async (tx: Prisma.TransactionClient) => {
    // If an admin pre-created an INVOICE (status=SENT/DRAFT/OVERDUE) for
    // this registration, promote it to PAID in place rather than minting
    // a duplicate. Matches the "manual invoice then payment lands" flow.
    const existing = await tx.invoice.findFirst({
      where: {
        registrationId,
        type: "INVOICE",
        status: { in: ["DRAFT", "SENT", "OVERDUE"] },
      },
      orderBy: { createdAt: "desc" },
    });

    if (existing) {
      return tx.invoice.update({
        where: { id: existing.id },
        data: {
          status: "PAID",
          paidDate: paid,
          paymentId,
          paymentMethod: paymentMethod || "stripe",
          paymentReference,
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

/** @deprecated Renamed to `createPaidInvoice`. Kept temporarily so any unmigrated
 *  external code still compiles; delegates 1:1 to the new function. Remove after
 *  the next release cycle. */
export const createReceipt = createPaidInvoice;

// ── Create Credit Note ──────────────────────────────────────────────────────

export async function createCreditNote(params: {
  registrationId: string;
  eventId: string;
  organizationId: string;
  originalInvoiceId?: string;
  reason?: string;
}): Promise<Invoice> {
  const { registrationId, eventId, organizationId, originalInvoiceId, reason } = params;

  const registration = await db.registration.findUniqueOrThrow({
    where: { id: registrationId },
    include: registrationInclude,
  });

  const { price, currency, discount, discountCode, taxRate, taxAmount, total } = calcInvoicePricing(registration);
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

  const creditNote = await db.$transaction(async (tx: Prisma.TransactionClient) => {
    const { sequenceNumber, invoiceNumber } = await getNextInvoiceNumber(
      tx, eventId, "CREDIT_NOTE", eventCode
    );

    // Mark the original invoice as REFUNDED
    if (parentId) {
      await tx.invoice.update({
        where: { id: parentId },
        data: { status: "REFUNDED" },
      });
    }

    return tx.invoice.create({
      data: {
        organizationId,
        eventId,
        registrationId,
        type: "CREDIT_NOTE",
        invoiceNumber,
        sequenceNumber,
        status: "REFUNDED",
        issueDate: new Date(),
        subtotal: price,
        discountCode,
        discountAmount: discount,
        taxRate,
        taxLabel: registration.event.taxLabel || "VAT",
        taxAmount,
        total,
        currency,
        parentInvoiceId: parentId,
        notes: reason || "Full refund",
      },
    });
  });

  apiLogger.info({ msg: "Credit note created", invoiceNumber: creditNote.invoiceNumber, registrationId, total: Number(creditNote.total), currency });
  return creditNote;
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
    eventName: reg.event.name,
    eventDate: reg.event.startDate,
    eventVenue: reg.event.venue,
    eventCity: reg.event.city,
    registrationType: reg.ticketType?.name ?? "General",
    pricingTier: reg.pricingTier?.name || null,
    price: Number(invoice.subtotal),
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
