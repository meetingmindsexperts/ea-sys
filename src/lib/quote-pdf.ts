import PDFDocument from "pdfkit";
import { apiLogger } from "./logger";
import { formatQuoteNumber } from "./invoice-numbering";
import { readRegistrationBasePrice } from "./registration-financials";
import {
  PAGE_MARGIN,
  drawHeader,
  drawInfoBoxes,
  drawLineItemsTable,
  drawTotals,
  drawNotesAndDisclaimer,
  drawBankDetails,
  drawFooters,
  ensureSpace,
  loadLocalLogo,
  formatDateShort,
} from "./pdf/document-layout";

interface QuoteData {
  // Document identity
  quoteNumber: string;
  date: Date;
  validUntil?: Date;

  // Event
  eventName: string;
  eventDate: Date;
  eventVenue: string | null;
  eventCity: string | null;

  // Registrant (personal — used as fallback when billing fields blank)
  firstName: string;
  lastName: string;
  email: string;
  organization: string | null;
  title: string | null;
  jobTitle: string | null;
  // Bill-to (from Registration.billing*). When all blank we fall back to
  // the personal block above so "billing same as personal" flows still
  // render correctly.
  billingFirstName?: string | null;
  billingLastName?: string | null;
  billingEmail?: string | null;
  billingPhone?: string | null;
  billingAddress?: string | null;
  billingCity: string | null;
  billingState?: string | null;
  billingZipCode?: string | null;
  billingCountry: string | null;
  taxNumber?: string | null;

  // "Charge to another account" — when set, the bill-to block renders this
  // third-party payer (the attendee's hospital / a pharma grant) INSTEAD of
  // the registrant/billing* block, and an "Attendee" reference line is added
  // so the payer's AP knows which doctor the invoice is for. Orthogonal to
  // payment status.
  payer?: {
    name: string;
    contactName?: string | null;
    email?: string | null;
    phone?: string | null;
    address?: string | null;
    city?: string | null;
    state?: string | null;
    zipCode?: string | null;
    country?: string | null;
    taxNumber?: string | null;
    reference?: string | null;
  } | null;

  // Line item
  registrationType: string;
  pricingTier: string | null;
  price: number;
  currency: string;
  /** Promo discount applied to the line item (0/omitted = none). */
  discountAmount?: number;
  /** Label for the discount row, e.g. "Promo SAVE10" (defaults to "Discount"). */
  discountLabel?: string | null;

  // Tax
  taxRate: number | null;
  taxLabel: string;

  // Payment info
  bankDetails: string | null;
  supportEmail: string | null;

  // Issuing organization
  organizationName: string;
  companyName: string | null;
  companyAddress: string | null;
  companyCity: string | null;
  companyState: string | null;
  companyZipCode: string | null;
  companyCountry: string | null;
  taxId: string | null;
  logoPath: string | null;
}

const QUOTE_NOTES = [
  "For immediate payment.",
  "Bookings and registrations cannot be confirmed until full receipt of payment or Purchase Order.",
  "All charges (including those of the beneficiary's bank) are to be paid by the sender.",
  "Please ensure you mention your quote reference in your bank transfer. Once you have processed the bank transfer please provide us the SWIFT message copy for the same from the bank in order for us to be able to allocate the payment.",
];

/**
 * Generates a registration quote/proforma invoice as a PDF buffer matching
 * the Meeting Minds reference layout.
 */
export async function generateQuotePDF(data: QuoteData): Promise<Buffer> {
  // Logo is loaded before opening the doc — fs is async, can't be done inline.
  const logoBuffer = await loadLocalLogo(data.logoPath);

  return new Promise((resolve, reject) => {
    try {
      // bufferPages: true so drawFooters can iterate via bufferedPageRange()
      // and stamp the correct "Page N/M" on every page after content is laid out.
      const doc = new PDFDocument({ size: "A4", margin: PAGE_MARGIN, bufferPages: true });
      const chunks: Buffer[] = [];
      doc.on("data", (chunk: Buffer) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", (err: Error) => {
        apiLogger.error({
          err,
          msg: "quote-pdf:stream-error",
          quoteNumber: data.quoteNumber,
          eventName: data.eventName,
        });
        reject(err);
      });

      // ── 1. Header (3 columns: company / centered title / logo) ──
      const addressLines = [
        data.companyAddress,
        [data.companyCity, data.companyZipCode].filter(Boolean).join(" "),
        data.companyCountry,
      ].filter((line): line is string => !!line && line.trim().length > 0);

      let y = drawHeader(doc, {
        companyBlock: {
          companyName: data.companyName || data.organizationName,
          addressLines,
          taxId: data.taxId,
        },
        centerTitle: data.eventName,
        documentTitle: "QUOTE",
        logoBuffer,
      });

      // ── 2. Bill-to + meta boxes ──
      // Bill-to person: prefer explicit billing first/last name over the
      // registrant's personal name (when "billing same as personal" is
      // unchecked, these diverge). Falls back to personal name otherwise.
      let nameLine: string;
      let secondLine: string | null;
      let addressLine: string | null;
      let locationLine: string | null;

      const meta = [
        { label: "Date", value: formatDateShort(data.date) },
        { label: "Quote Reference", value: data.quoteNumber },
      ];

      if (data.payer) {
        // Third-party billing: bill-to = the payer. The attendee moves to a
        // reference line so AP knows which registration this covers.
        nameLine = data.payer.name;
        secondLine = data.payer.contactName || null;
        addressLine = data.payer.address || null;
        locationLine = [
          data.payer.city,
          [data.payer.state, data.payer.zipCode].filter(Boolean).join(" "),
          data.payer.country,
        ].filter(Boolean).join(", ") || null;

        const attendeeName = [data.title, data.firstName, data.lastName]
          .filter(Boolean)
          .join(" ");
        meta.push({ label: "Attendee", value: attendeeName });
        if (data.payer.reference)
          meta.push({ label: "PO / Reference", value: data.payer.reference });
        if (data.payer.taxNumber)
          meta.push({ label: "Tax Number", value: data.payer.taxNumber });
        if (data.payer.email)
          meta.push({ label: "Billing Email", value: data.payer.email });
        if (data.payer.phone)
          meta.push({ label: "Billing Phone", value: data.payer.phone });
      } else {
        // Self-pay (unchanged): prefer explicit billing name over personal.
        const billFirst = data.billingFirstName || data.firstName;
        const billLast = data.billingLastName || data.lastName;
        const namePart = [data.title, billFirst].filter(Boolean).join(" ");
        nameLine = namePart ? `${billLast}, ${namePart}` : billLast;

        secondLine = data.jobTitle || data.organization;
        addressLine = data.billingAddress || null;
        locationLine = [
          data.billingCity,
          [data.billingState, data.billingZipCode].filter(Boolean).join(" "),
          data.billingCountry,
        ].filter(Boolean).join(", ") || null;

        if (data.taxNumber) meta.push({ label: "Tax Number", value: data.taxNumber });
        if (data.billingEmail) meta.push({ label: "Billing Email", value: data.billingEmail });
        if (data.billingPhone) meta.push({ label: "Billing Phone", value: data.billingPhone });
      }

      y = ensureSpace(doc, y, 80);
      y = drawInfoBoxes(doc, y, {
        billTo: {
          nameLine,
          secondLine,
          addressLine,
          locationLine,
        },
        meta,
      });

      // ── 3. Line items ──
      const itemDescription = data.pricingTier
        ? `${data.registrationType} - ${data.pricingTier}`
        : data.registrationType;

      y = ensureSpace(doc, y, 80);
      y = drawLineItemsTable(doc, y, data.currency, [
        {
          name: "Registration",
          items: [{ description: itemDescription, amount: data.price }],
        },
      ]);

      // ── 4. Totals — always Subtotal + (Discount) + VAT + Total ──
      y = ensureSpace(doc, y, 90);
      y = drawTotals(doc, y, {
        currency: data.currency,
        subtotal: data.price,
        discountAmount: data.discountAmount ?? 0,
        discountLabel: data.discountLabel ?? null,
        taxRate: data.taxRate,
        taxLabel: data.taxLabel,
      });

      // ── 5. Important notes (matches sample) + VAT disclaimer ──
      const showVatDisclaimer = !!data.taxRate && data.taxRate > 0;
      y = ensureSpace(doc, y, 120);
      y = drawNotesAndDisclaimer(doc, y, QUOTE_NOTES, showVatDisclaimer);

      // ── 6. Bank details ──
      if (data.bankDetails) {
        y = ensureSpace(doc, y, 90);
        drawBankDetails(doc, y, data.bankDetails);
      }

      // ── 7. Footers — written after content so Page N/M reflects real layout ──
      drawFooters(doc, data.date);

      doc.end();
    } catch (err) {
      apiLogger.error({
        err,
        msg: "quote-pdf:render-failed",
        quoteNumber: data.quoteNumber,
        eventName: data.eventName,
      });
      reject(err);
    }
  });
}

// ── Shared registration → quote PDF builder ────────────────────────────────
//
// Both `/api/registrant/registrations/[id]/quote` (auth-required) and
// `/api/public/events/[slug]/registrations/[id]/document` (public, post-
// checkout fallback) used to repeat the same ~70 lines of registration→
// quote-PDF mapping verbatim. This builder is the single source of truth.
//
// The shape below is the minimal nested SELECT both callers rely on; a
// fresh `findFirst({ include: { ... } })` whose result fits the type below
// will work. Don't pass a registration with the wrong includes — TypeScript
// will catch the missing fields, not silently miss them.

export interface RegistrationForQuotePDF {
  id: string;
  serialId: number | null;
  createdAt: Date;
  billingFirstName: string | null;
  billingLastName: string | null;
  billingEmail: string | null;
  billingPhone: string | null;
  billingAddress: string | null;
  billingCity: string | null;
  billingState: string | null;
  billingZipCode: string | null;
  billingCountry: string | null;
  taxNumber: string | null;
  // "Charge to another account" — when present, the bill-to becomes this
  // payer and the attendee drops to a reference line. null = self-pay.
  payerReference: string | null;
  billingAccount: {
    name: string;
    contactName: string | null;
    email: string | null;
    phone: string | null;
    address: string | null;
    city: string | null;
    state: string | null;
    zipCode: string | null;
    country: string | null;
    taxNumber: string | null;
  } | null;
  attendee: {
    firstName: string;
    lastName: string;
    email: string;
    organization: string | null;
    title: string | null;
    jobTitle: string | null;
    city: string | null;
    country: string | null;
  };
  // Decimal columns surface as Prisma.Decimal at runtime; we accept the
  // structural type and Number()-coerce inside the builder.
  ticketType: { name: string; price: unknown; currency: string } | null;
  pricingTier: { name: string; price: unknown; currency: string } | null;
  // Stamped base price (preferred over the tier/ticket price so tier-priced /
  // VIRTUAL registrations don't resolve to 0).
  originalPrice?: unknown;
  // Applied promo discount — surfaced as a Discount row on the quote.
  discountAmount?: unknown;
  promoCode?: { code: string } | null;
  event: {
    name: string;
    code: string | null;
    startDate: Date;
    venue: string | null;
    city: string | null;
    taxRate: unknown;
    taxLabel: string | null;
    bankDetails: string | null;
    supportEmail: string | null;
    organization: {
      name: string;
      companyName: string | null;
      companyAddress: string | null;
      companyCity: string | null;
      companyState: string | null;
      companyZipCode: string | null;
      companyCountry: string | null;
      taxId: string | null;
      logo: string | null;
    };
  };
}

export interface QuotePDFBuildResult {
  buffer: Buffer;
  filename: string;
  quoteNumber: string;
}

/**
 * Derive the quote number for a registration. Uses the formal
 * `formatQuoteNumber(eventCode, serialId)` when both are available; falls
 * back to `${eventCode}-Q-${last-4-of-id}` for legacy registrations
 * without a serialId.
 */
function deriveQuoteNumber(
  eventCode: string,
  serialId: number | null,
  registrationId: string,
): string {
  return serialId
    ? formatQuoteNumber(eventCode, serialId)
    : `${eventCode}-Q-${registrationId.slice(-4).toUpperCase()}`;
}

/**
 * Build a quote PDF for a registration. Single source of truth for the
 * registration → `generateQuotePDF` parameter mapping.
 *
 * Returns the rendered buffer + a stable filename + the derived quote
 * number. Caller is responsible for the HTTP layer (response, headers,
 * auth, rate limit).
 */
export async function buildQuotePDFFromRegistration(
  registration: RegistrationForQuotePDF,
): Promise<QuotePDFBuildResult> {
  const price = readRegistrationBasePrice(registration);

  const currency = registration.pricingTier
    ? registration.pricingTier.currency
    : registration.ticketType?.currency ?? "USD";

  const eventCode =
    registration.event.code || registration.event.name.slice(0, 6).toUpperCase();
  const quoteNumber = deriveQuoteNumber(eventCode, registration.serialId, registration.id);

  const org = registration.event.organization;

  const buffer = await generateQuotePDF({
    quoteNumber,
    date: registration.createdAt,
    eventName: registration.event.name,
    eventDate: registration.event.startDate,
    eventVenue: registration.event.venue,
    eventCity: registration.event.city,
    firstName: registration.attendee.firstName,
    lastName: registration.attendee.lastName,
    email: registration.attendee.email,
    organization: registration.attendee.organization,
    title: registration.attendee.title,
    jobTitle: registration.attendee.jobTitle,
    billingFirstName: registration.billingFirstName,
    billingLastName: registration.billingLastName,
    billingEmail: registration.billingEmail,
    billingPhone: registration.billingPhone,
    billingAddress: registration.billingAddress,
    // Personal city/country are the fallback when billing fields are blank
    // — same behavior both call sites had before extraction.
    billingCity: registration.billingCity || registration.attendee.city,
    billingState: registration.billingState,
    billingZipCode: registration.billingZipCode,
    billingCountry: registration.billingCountry || registration.attendee.country,
    taxNumber: registration.taxNumber,
    payer: registration.billingAccount
      ? {
          name: registration.billingAccount.name,
          contactName: registration.billingAccount.contactName,
          email: registration.billingAccount.email,
          phone: registration.billingAccount.phone,
          address: registration.billingAccount.address,
          city: registration.billingAccount.city,
          state: registration.billingAccount.state,
          zipCode: registration.billingAccount.zipCode,
          country: registration.billingAccount.country,
          taxNumber: registration.billingAccount.taxNumber,
          reference: registration.payerReference,
        }
      : null,
    registrationType: registration.ticketType?.name ?? "General",
    pricingTier: registration.pricingTier?.name || null,
    price,
    currency,
    discountAmount: registration.discountAmount ? Number(registration.discountAmount) : 0,
    discountLabel: registration.promoCode?.code ? `Promo ${registration.promoCode.code}` : null,
    taxRate: registration.event.taxRate ? Number(registration.event.taxRate) : null,
    taxLabel: registration.event.taxLabel || "VAT",
    bankDetails: registration.event.bankDetails,
    supportEmail: registration.event.supportEmail,
    organizationName: org.name,
    companyName: org.companyName,
    companyAddress: org.companyAddress,
    companyCity: org.companyCity,
    companyState: org.companyState,
    companyZipCode: org.companyZipCode,
    companyCountry: org.companyCountry,
    taxId: org.taxId,
    logoPath: org.logo,
  });

  // Filename pattern matches what both routes used previously, so download
  // history / browser autocomplete is unchanged.
  const filename = `quote-${registration.id.slice(-8)}.pdf`;
  return { buffer, filename, quoteNumber };
}
