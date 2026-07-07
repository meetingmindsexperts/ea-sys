/**
 * Payment-confirmation email — the single "Payment received" message a payer
 * gets once a payment lands (Stripe, manual/offline, or reconciliation).
 *
 * Extracted from the Stripe webhook so ALL payment channels send the SAME
 * branded, per-event-customizable email. It now carries the finance documents
 * as attachments (the PAID invoice PDF + the receipt PDF) so the payer receives
 * one combined packet instead of separate confirmation / invoice emails.
 */
import { apiLogger } from "@/lib/logger";
import {
  sendEmail,
  getEventTemplate,
  getDefaultTemplate,
  renderAndWrap,
  renderTemplatePlain,
  brandingFrom,
  brandingCc,
} from "@/lib/email";
import { getTitleLabel } from "@/lib/utils";
import { computeRegistrationFinancials, readRegistrationBasePrice } from "@/lib/registration-financials";

/**
 * Accounting inboxes BCC'd on every financial-document email so finance keeps a
 * copy of each issued invoice / receipt / credit note. BCC (not CC) so the
 * attendee never sees these internal addresses. Shared with `invoice-service`.
 */
export const INVOICE_ACCOUNTING_BCC = [
  { email: "accounts@meetingmindsdubai.com" },
  { email: "accounts@meetingmindsexperts.com" },
];

/** Registration shape the confirmation email needs. Load scalars (via `include`,
 *  which returns all Registration scalar columns — `discountAmount`, `serialId`)
 *  plus these relations. */
export const paymentConfirmationRegInclude = {
  attendee: { select: { firstName: true, lastName: true, email: true, additionalEmail: true, title: true } },
  ticketType: { select: { name: true, price: true, currency: true } },
  pricingTier: { select: { price: true, currency: true } },
  event: {
    select: {
      id: true, organizationId: true, name: true, slug: true, startDate: true,
      venue: true, city: true, taxRate: true, taxLabel: true,
    },
  },
} as const;

export interface PaymentConfirmationRegistration {
  id: string;
  serialId: number | null;
  attendee: {
    firstName: string;
    lastName: string;
    email: string;
    additionalEmail: string | null;
    title: string | null;
  };
  ticketType: { name: string; price: unknown; currency: string } | null;
  pricingTier: { price: unknown; currency: string } | null;
  discountAmount: unknown;
  event: {
    id: string;
    organizationId: string;
    name: string;
    slug: string;
    startDate: Date;
    venue: string | null;
    city: string | null;
    taxRate: unknown;
    taxLabel: string | null;
  };
}

export interface PaymentEmailAttachment {
  name: string;
  content: string; // base64
  contentType: string;
}

/**
 * Send the payment-confirmation email. When `attachments` are supplied (the
 * invoice + receipt PDFs) the email is the combined post-payment packet and
 * accounting is BCC'd. `receiptUrl` renders Stripe's hosted-receipt button when
 * present; `paymentReference` is the transaction identifier surfaced in the body.
 */
export async function sendPaymentConfirmationEmail(
  registration: PaymentConfirmationRegistration,
  amount: number,
  currency: string,
  receiptUrl: string | null,
  paymentReference: string | null,
  attachments?: PaymentEmailAttachment[],
): Promise<void> {
  const eventDate = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date(registration.event.startDate));

  const paymentDate = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date());

  // Totals via the canonical computeRegistrationFinancials so the breakdown
  // matches the invoice PDF. These breakdown vars feed only CUSTOM templates;
  // the default template renders {{amount}} (the actual paid amount).
  const basePrice = readRegistrationBasePrice(registration);
  const discount = registration.discountAmount ? Number(registration.discountAmount) : 0;
  const taxLabel = registration.event.taxLabel || "VAT";
  const fin = computeRegistrationFinancials({
    subtotal: basePrice,
    discount,
    taxRate: Number(registration.event.taxRate || 0),
    taxLabel,
    currency,
    totalPaid: amount,
  });
  const taxRate = fin.taxRate;
  const taxAmount = fin.taxAmount;
  const subtotal = fin.subtotal;
  const total = fin.total;

  const discountBlock = fin.discount > 0
    ? `<tr><td style="padding: 4px 0; color: #555; font-size: 14px;">Discount</td><td style="padding: 4px 0; text-align: right; font-size: 14px;">&minus;${currency} ${fin.discount.toFixed(2)}</td></tr>`
    : "";

  const taxBlock = taxRate > 0
    ? `<tr><td style="padding: 4px 0; color: #555; font-size: 14px;">${taxLabel} (${taxRate}%)</td><td style="padding: 4px 0; text-align: right; font-size: 14px;">${currency} ${taxAmount.toFixed(2)}</td></tr>`
    : "";

  // Receipt block: the Stripe-hosted receipt button (only when Stripe gave us a
  // receipt URL) + a note that the invoice & receipt PDFs are attached to THIS
  // email (previously they arrived separately — now they ride along).
  const receiptButton = receiptUrl
    ? `<div style="text-align: center; margin: 20px 0 0 0;">
        <a href="${receiptUrl}" style="display: inline-block; background: #00aade; color: white; padding: 12px 28px; text-decoration: none; border-radius: 8px; font-weight: 500; font-size: 14px;">View Receipt</a>
      </div>`
    : "";
  const attachmentNote = attachments?.length
    ? `<p style="text-align: center; font-size: 13px; color: #6b7280; margin: 10px 0 0 0;">Your invoice and receipt are attached to this email as PDF documents.</p>`
    : "";
  const receiptBlock = receiptButton + attachmentNote;
  const receiptBlockText =
    (receiptUrl ? `View Receipt: ${receiptUrl}\n` : "") +
    (attachments?.length ? "Your invoice and receipt are attached to this email as PDF documents." : "");

  const displayRegistrationId =
    registration.serialId != null
      ? String(registration.serialId).padStart(3, "0")
      : registration.id;

  const vars: Record<string, string | number | undefined> = {
    title: getTitleLabel(registration.attendee.title),
    firstName: registration.attendee.firstName,
    lastName: registration.attendee.lastName,
    eventName: registration.event.name,
    eventDate,
    eventVenue: [registration.event.venue, registration.event.city].filter(Boolean).join(", "),
    registrationId: displayRegistrationId,
    paymentReference: paymentReference ?? "—",
    ticketType: registration.ticketType?.name ?? "General",
    amount: `${currency} ${amount.toFixed(2)}`,
    currency,
    paymentDate,
    receiptUrl: receiptUrl || undefined,
    receiptBlock,
    subtotal: `${currency} ${subtotal.toFixed(2)}`,
    discount: fin.discount > 0 ? `${currency} ${fin.discount.toFixed(2)}` : undefined,
    discountBlock,
    taxRate: taxRate > 0 ? taxRate : undefined,
    taxLabel: taxRate > 0 ? taxLabel : undefined,
    taxAmount: taxRate > 0 ? `${currency} ${taxAmount.toFixed(2)}` : undefined,
    total: `${currency} ${total.toFixed(2)}`,
    taxBlock,
  };

  const tpl = await getEventTemplate(registration.event.id, "payment-confirmation");
  const template = tpl || getDefaultTemplate("payment-confirmation");

  if (!template) {
    apiLogger.warn({ msg: "No payment-confirmation template found", registrationId: registration.id });
    return;
  }

  const branding = tpl?.branding || { eventName: registration.event.name };
  const rendered = renderAndWrap(template, vars, branding, new Set(["receiptBlock", "taxBlock", "discountBlock"]));

  // Override text content with the plain-text receipt link.
  const textVars = { ...vars, receiptBlock: receiptBlockText };
  rendered.textContent = renderTemplatePlain(template.textContent, textVars);

  await sendEmail({
    to: [{ email: registration.attendee.email, name: registration.attendee.firstName }],
    cc: brandingCc(
      branding,
      [{ email: registration.attendee.email }],
      [registration.attendee.additionalEmail],
    ),
    bcc: attachments?.length ? INVOICE_ACCOUNTING_BCC : undefined,
    ...rendered,
    ...(attachments?.length ? { attachments } : {}),
    from: brandingFrom(branding),
    emailType: "payment_confirmation",
    stream: "transactional",
    logContext: {
      organizationId: registration.event.organizationId,
      eventId: registration.event.id,
      entityType: "REGISTRATION",
      entityId: registration.id,
      templateSlug: "payment-confirmation",
    },
  });

  apiLogger.info({
    msg: "Payment confirmation email sent",
    registrationId: registration.id,
    attachments: attachments?.length ?? 0,
  });
}
