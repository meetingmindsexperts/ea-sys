import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { getNextInvoiceNumber } from "@/lib/invoice-numbering";
import { generateInvoicePDF, type InvoicePDFData } from "@/lib/invoice-pdf";
import { generateReceiptPDF, type ReceiptPDFData } from "@/lib/receipt-pdf";
import { generateCreditNotePDF, type CreditNotePDFData } from "@/lib/credit-note-pdf";
import { sendEmail } from "@/lib/email";
import { getTitleLabel } from "@/lib/utils";
import type { Invoice } from "@prisma/client";

// ── Shared query for building PDF data ──────────────────────────────────────

const registrationInclude = {
  attendee: true,
  ticketType: { select: { name: true, price: true, currency: true } },
  pricingTier: { select: { name: true, price: true, currency: true } },
  event: {
    select: {
      name: true, startDate: true, venue: true, city: true,
      taxRate: true, taxLabel: true, bankDetails: true, supportEmail: true,
      organization: {
        select: {
          name: true, primaryColor: true, invoicePrefix: true,
          companyName: true, companyAddress: true, companyCity: true,
          companyState: true, companyZipCode: true, companyCountry: true,
          companyPhone: true, companyEmail: true, taxId: true,
        },
      },
    },
  },
} as const;

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

  const price = Number(registration.pricingTier?.price ?? registration.ticketType.price);
  const currency = registration.pricingTier?.currency ?? registration.ticketType.currency;
  const taxRate = registration.event.taxRate ? Number(registration.event.taxRate) : null;
  const taxAmount = taxRate ? price * (taxRate / 100) : 0;
  const total = price + taxAmount;
  const org = registration.event.organization;

  return db.$transaction(async (tx) => {
    const { sequenceNumber, invoiceNumber } = await getNextInvoiceNumber(
      tx, organizationId, "INVOICE", org.invoicePrefix || undefined
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
        taxRate,
        taxLabel: registration.event.taxLabel || "VAT",
        taxAmount,
        total,
        currency,
      },
    });
  });
}

// ── Create Receipt ──────────────────────────────────────────────────────────

export async function createReceipt(params: {
  registrationId: string;
  eventId: string;
  organizationId: string;
  paymentId: string;
  paymentMethod?: string;
  paymentReference?: string;
}): Promise<Invoice> {
  const { registrationId, eventId, organizationId, paymentId, paymentMethod, paymentReference } = params;

  const registration = await db.registration.findUniqueOrThrow({
    where: { id: registrationId },
    include: registrationInclude,
  });

  const price = Number(registration.pricingTier?.price ?? registration.ticketType.price);
  const currency = registration.pricingTier?.currency ?? registration.ticketType.currency;
  const taxRate = registration.event.taxRate ? Number(registration.event.taxRate) : null;
  const taxAmount = taxRate ? price * (taxRate / 100) : 0;
  const total = price + taxAmount;

  return db.$transaction(async (tx) => {
    const { sequenceNumber, invoiceNumber } = await getNextInvoiceNumber(
      tx, organizationId, "RECEIPT"
    );

    // Mark any existing invoice for this registration as PAID
    await tx.invoice.updateMany({
      where: { registrationId, type: "INVOICE", status: { in: ["DRAFT", "SENT", "OVERDUE"] } },
      data: { status: "PAID", paidDate: new Date() },
    });

    return tx.invoice.create({
      data: {
        organizationId,
        eventId,
        registrationId,
        paymentId,
        type: "RECEIPT",
        invoiceNumber,
        sequenceNumber,
        status: "PAID",
        issueDate: new Date(),
        paidDate: new Date(),
        subtotal: price,
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
}

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

  const price = Number(registration.pricingTier?.price ?? registration.ticketType.price);
  const currency = registration.pricingTier?.currency ?? registration.ticketType.currency;
  const taxRate = registration.event.taxRate ? Number(registration.event.taxRate) : null;
  const taxAmount = taxRate ? price * (taxRate / 100) : 0;
  const total = price + taxAmount;

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

  return db.$transaction(async (tx) => {
    const { sequenceNumber, invoiceNumber } = await getNextInvoiceNumber(
      tx, organizationId, "CREDIT_NOTE"
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
}

// ── Generate PDF ────────────────────────────────────────────────────────────

export async function generatePDFForInvoice(invoiceId: string): Promise<Buffer> {
  const invoice = await db.invoice.findUniqueOrThrow({
    where: { id: invoiceId },
    include: {
      registration: { include: registrationInclude },
      parentInvoice: { select: { invoiceNumber: true } },
    },
  });

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
      registrationType: reg.ticketType.name,
      pricingTier: reg.pricingTier?.name || null,
      price: Number(invoice.subtotal),
      currency: invoice.currency,
      taxRate: invoice.taxRate ? Number(invoice.taxRate) : null,
      taxLabel: invoice.taxLabel || "VAT",
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
      registrationType: reg.ticketType.name,
      pricingTier: reg.pricingTier?.name || null,
      price: Number(invoice.subtotal),
      currency: invoice.currency,
      taxRate: invoice.taxRate ? Number(invoice.taxRate) : null,
      taxLabel: invoice.taxLabel || "VAT",
      notes: invoice.notes,
    };
    return generateCreditNotePDF(cnData);
  }

  // Default: INVOICE
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
    firstName: reg.attendee.firstName,
    lastName: reg.attendee.lastName,
    email: reg.attendee.email,
    organization: reg.attendee.organization,
    title: titleLabel || null,
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
    registrationType: reg.ticketType.name,
    pricingTier: reg.pricingTier?.name || null,
    price: Number(invoice.subtotal),
    currency: invoice.currency,
    taxRate: invoice.taxRate ? Number(invoice.taxRate) : null,
    taxLabel: invoice.taxLabel || "VAT",
    bankDetails: reg.event.bankDetails,
    supportEmail: reg.event.supportEmail,
  };
  return generateInvoicePDF(invoiceData);
}

// ── Send Invoice Email ──────────────────────────────────────────────────────

export async function sendInvoiceEmail(invoiceId: string): Promise<void> {
  const invoice = await db.invoice.findUniqueOrThrow({
    where: { id: invoiceId },
    include: {
      registration: {
        include: {
          attendee: { select: { firstName: true, lastName: true, email: true } },
          event: {
            select: {
              name: true,
              emailFromAddress: true,
              emailFromName: true,
            },
          },
        },
      },
    },
  });

  const { attendee, event } = invoice.registration;
  const pdfBuffer = await generatePDFForInvoice(invoiceId);

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
  return db.invoice.update({
    where: { id: invoiceId },
    data: { status: "CANCELLED" },
  });
}
