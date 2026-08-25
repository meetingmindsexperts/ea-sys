import { NextResponse } from "next/server";
import { z } from "zod";
import { db, tenantTransaction } from "@/lib/db";
import { generateBarcode } from "@/lib/utils";
import { getNextSerialId } from "@/lib/registration-serial";
import { apiLogger } from "@/lib/logger";
import { publicEventWhere } from "@/lib/public-event";
import { isPresenterTierName } from "@/lib/presenter-tiers";
import { runWithTenant } from "@/lib/tenant-context";
import { sendRegistrationConfirmation } from "@/lib/email";
import { sendWebinarConfirmationForRegistration } from "@/lib/webinar-email-sequence";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { titleEnum, attendeeRoleEnum } from "@/lib/schemas";
import { syncToContact } from "@/lib/contact-sync";
import { notifyEventAdmins } from "@/lib/notifications";
import { refreshEventStats } from "@/lib/event-stats";
import { ensureRegistrantAccount } from "@/lib/registrant-account";
import { claimEventSeats } from "@/lib/registration-seat-db";
import { claimSpareDtcmCode } from "@/lib/dtcm-pool";
import { buildEventConfirmationFields } from "@/lib/registration-confirmation";
import {
  SUPPORTING_DOCUMENT_PATH_PREFIX,
  isSupportingDocumentPath,
  requiresSupportingDocument,
  supportingDocumentBlocks,
  supportingDocumentLabel,
} from "@/lib/supporting-document";

const registrationSchema = z.object({
  ticketTypeId: z.string().min(1).max(100),
  // Venue vs online. Only meaningful on HYBRID events; the server ignores a
  // VIRTUAL choice on non-hybrid events and falls back to IN_PERSON.
  attendanceMode: z.enum(["IN_PERSON", "VIRTUAL"]).optional(),
  // Coerce "" → undefined so legacy (non-tier) tickets — whose client form
  // always submits pricingTierId: "" — aren't rejected by min(1).
  pricingTierId: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().min(1).max(100).optional()
  ),
  title: titleEnum,
  role: attendeeRoleEnum,
  firstName: z.string().min(1, "First name is required").max(100),
  lastName: z.string().min(1, "Last name is required").max(100),
  email: z.string().email("Valid email is required").max(255),
  additionalEmail: z.string().email().max(255).optional().or(z.literal("")),
  organization: z.string().min(1, "Organization is required").max(255),
  jobTitle: z.string().min(1, "Position is required").max(255),
  phone: z.string().min(1, "Mobile number is required").max(50),
  city: z.string().min(1, "City is required").max(255),
  state: z.string().max(255).optional(),
  zipCode: z.string().max(20).optional(),
  country: z.string().min(1, "Country is required").max(255),
  specialty: z.string().min(1, "Specialty is required").max(255),
  customSpecialty: z.string().max(255).optional(),
  dietaryReqs: z.string().max(2000).optional(),
  // Member-specific fields
  associationName: z.string().max(255).optional(),
  memberId: z.string().max(100).optional(),
  // Student-specific fields
  studentId: z.string().max(100).optional(),
  studentIdExpiry: z.string().max(20).optional(),
  // Supporting document — the path returned by the upload route,
  // shape-validated below before it is trusted.
  supportingDocumentUrl: z.string().max(500).optional(),
  supportingDocumentFilename: z.string().max(255).optional(),
  // DEPRECATED aliases, added Aug 14 2026, REMOVE after ~1 week.
  //
  // The Aug 13 rename changed the route AND these field names in one deploy. A
  // registrant holding the pre-swap browser bundle posts the OLD names, and Zod
  // strips unknown keys — so the path was silently discarded, with no
  // `path-rejected` log either, because the code never entered the branch that
  // logs. The registration succeeded, the organizer never got the document, and
  // the file was pruned 24h later. Accepting the old names costs two lines and
  // makes the skew window a non-event.
  residentLetterUrl: z.string().max(500).optional(),
  residentLetterFilename: z.string().max(255).optional(),
  // Billing details
  taxNumber: z.string().max(100).optional(),
  billingFirstName: z.string().max(100).optional(),
  billingLastName: z.string().max(100).optional(),
  billingEmail: z.string().email().max(255).optional().or(z.literal("")),
  billingPhone: z.string().max(50).optional(),
  billingAddress: z.string().max(500).optional(),
  billingCity: z.string().max(255).optional(),
  billingState: z.string().max(255).optional(),
  billingZipCode: z.string().max(20).optional(),
  billingCountry: z.string().max(255).optional(),
  // Promo code
  promoCode: z.string().max(50).optional(),
  // Account creation
  password: z.string().min(6).max(128).optional(),
  // Tracking
  referrer: z.string().max(2000).optional(),
  utmSource: z.string().max(255).optional(),
  utmMedium: z.string().max(255).optional(),
  utmCampaign: z.string().max(255).optional(),
}).refine(
  (data) => data.specialty !== "Others" || (data.customSpecialty?.trim().length ?? 0) > 0,
  {
    message: "Please specify your specialty",
    path: ["customSpecialty"],
  },
);

interface RouteParams {
  params: Promise<{ slug: string }>;
}

export async function POST(req: Request, { params }: RouteParams) {
  // Hoisted so the catch block's business-rejection log (M12) can name the
  // event even though the destructure happens inside the try.
  let slugForLog: string | undefined;
  try {
    const clientIp = getClientIp(req);

    // Burst limiter: catch bots hammering the endpoint (15 req / 60s per IP).
    // Raised from 3 → 15 so several genuine registrants behind one shared NAT
    // (hospital / office / venue WiFi) submitting near-simultaneously aren't
    // throttled, while still stopping a script hammering the endpoint.
    const burstLimit = checkRateLimit({
      key: `public-register:burst:${clientIp}`,
      limit: 15,
      windowMs: 60 * 1000,
    });
    if (!burstLimit.allowed) {
      apiLogger.warn({ msg: "public/register:rate-limited", retryAfterSeconds: burstLimit.retryAfterSeconds, ip: clientIp });
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        { status: 429, headers: { "Retry-After": String(burstLimit.retryAfterSeconds) } }
      );
    }

    // Sustained limiter: 100 registrations per IP per 15 min. Raised from 10 so a
    // large shared NAT (a hospital/office with many staff registering for a
    // conference, or venue WiFi) isn't blocked; still caps runaway abuse from a
    // single source.
    const ipRateLimit = checkRateLimit({
      key: `public-register:ip:${clientIp}`,
      limit: 100,
      windowMs: 15 * 60 * 1000,
    });

    if (!ipRateLimit.allowed) {
      apiLogger.warn({ msg: "public/register:rate-limited", retryAfterSeconds: ipRateLimit.retryAfterSeconds, ip: clientIp });
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        { status: 429, headers: { "Retry-After": String(ipRateLimit.retryAfterSeconds) } }
      );
    }

    const [{ slug }, body] = await Promise.all([params, req.json()]);
    slugForLog = slug;

    const validated = registrationSchema.safeParse(body);

    if (!validated.success) {
        apiLogger.warn({ msg: "public/events/register:zod-validation-failed", errors: validated.error.flatten() });
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const { ticketTypeId, pricingTierId, title, role, firstName, lastName, additionalEmail, organization, jobTitle, phone, city, state, zipCode, country, specialty, customSpecialty, dietaryReqs, associationName, memberId, studentId, studentIdExpiry, supportingDocumentUrl, supportingDocumentFilename, taxNumber, billingFirstName, billingLastName, billingEmail, billingPhone, billingAddress, billingCity, billingState, billingZipCode, billingCountry, password, promoCode, referrer, utmSource, utmMedium, utmCampaign } =
      validated.data;
    const email = validated.data.email.toLowerCase();
    const attendanceModeInput = validated.data.attendanceMode;

    // Per-email-address limiter (keyed on the email, not IP) — 10 / 15 min.
    // Raised from 5 to allow genuine retries/edits without throttling; still
    // prevents one address from spamming many registrations.
    const emailRateLimit = checkRateLimit({
      key: `public-register:email:${email}`,
      limit: 10,
      windowMs: 15 * 60 * 1000,
    });

    if (!emailRateLimit.allowed) {
      apiLogger.warn({ msg: "public/register:rate-limited", retryAfterSeconds: emailRateLimit.retryAfterSeconds });
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        { status: 429, headers: { "Retry-After": String(emailRateLimit.retryAfterSeconds) } }
      );
    }

    // Find the event (supports both slug and event ID; tenant-scoped by host)
    const event = await db.event.findFirst({
      where: await publicEventWhere(req, slug, {
        allowIdFallback: true,
        statuses: ["PUBLISHED", "LIVE"],
      }),
      select: {
        id: true,
        // Drives the DTCM spare-code claim after the registration commits.
        requiresDtcmBarcode: true,
        name: true,
        eventType: true,
        startDate: true,
        timezone: true,
        endDate: true,
        venue: true,
        city: true,
        country: true,
        organizationId: true,
        settings: true,
        maxAttendees: true,
        seatCount: true,
        taxRate: true,
        taxLabel: true,
        bankDetails: true,
        supportEmail: true,
        organization: {
          select: {
            name: true,
            companyName: true,
            companyAddress: true,
            companyCity: true,
            companyState: true,
            companyZipCode: true,
            companyCountry: true,
            taxId: true,
            logo: true,
          },
        },
      },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    return await runWithTenant(event.organizationId, async () => {
    // Master registration switch (Settings → Registration). Enforced server-side
    // so a closed event can't be registered via a direct POST, regardless of UI
    // or which individual tiers are active. Default OPEN when the field is absent.
    const eventSettings = (event.settings || {}) as Record<string, unknown>;
    if (eventSettings.registrationOpen === false) {
      apiLogger.warn({ msg: "public/register:registration-closed", slug, eventId: event.id });
      return NextResponse.json(
        { error: "Registration is closed for this event.", code: "REGISTRATION_CLOSED" },
        { status: 403 },
      );
    }

    // Validate ticket type
    const ticketType = await db.ticketType.findFirst({
      where: {
        id: ticketTypeId,
        eventId: event.id,
        isActive: true,
        // Internal Faculty type is not publicly registerable (defense in depth
        // — it's already hidden from the public ticket list).
        isFaculty: false,
      },
    });

    if (!ticketType) {
      return NextResponse.json(
        { error: "Registration type not found or inactive" },
        { status: 404 }
      );
    }

    // Virtual attendance is only honored on HYBRID events. A VIRTUAL choice on
    // any other event type silently falls back to IN_PERSON. Virtual ⇒ no
    // qrCode/badge, uncapped (skips capacity + soldCount), and priced via the
    // ticket's flat `virtualPrice` (null ⇒ in-person price).
    const isVirtual =
      event.eventType === "HYBRID" && attendanceModeInput === "VIRTUAL";
    const attendanceMode = isVirtual ? "VIRTUAL" : "IN_PERSON";

    // Resolve pricing tier (new flow) or fall back to legacy ticketType fields
    let pricingTier: { id: string; name: string; price: number | unknown; currency: string; quantity: number; soldCount: number; requiresApproval: boolean; salesStart: Date | null; salesEnd: Date | null } | null = null;

    if (pricingTierId) {
      const tier = await db.pricingTier.findFirst({
        where: { id: pricingTierId, ticketTypeId, isActive: true },
      });
      if (!tier) {
        // M12: log every rejection on the money-critical public path.
        apiLogger.warn({ msg: "public/register:pricing-tier-not-found", eventId: event.id, ticketTypeId, pricingTierId });
        return NextResponse.json({ error: "Pricing tier not found or inactive" }, { status: 404 });
      }
      // A presenter rate is NOT a delegate rate. The tier's own form URL is
      // shareable (`/e/<slug>/register/presenter-early-bird`) and the
      // organizer UI even has a copy-link button, so without this a forwarded
      // link works like a discount code with no code on it: presenter rates
      // are usually set BELOW the delegate ones, the person gets no abstract
      // and no speaker record, and they consume the presenter tier's seat
      // allocation. Presenters register through the abstract signup, which is
      // where the rate is actually offered (owner decision Aug 12, 2026).
      //
      // Enforced HERE and not only on the page, because this endpoint accepts
      // a pricingTierId directly: a UI-only refusal would be theatre.
      if (isPresenterTierName(tier.name)) {
        apiLogger.warn({
          msg: "public/register:presenter-tier-refused",
          eventId: event.id,
          ticketTypeId,
          pricingTierId,
          tierName: tier.name,
        });
        return NextResponse.json(
          {
            error:
              "This rate is for abstract presenters. Please submit an abstract to register at this rate.",
            code: "PRESENTER_TIER_NOT_PUBLIC",
            abstractRegisterPath: `/e/${slug}/abstract/register`,
          },
          { status: 403 },
        );
      }
      pricingTier = tier;
    }

    // Use pricing tier for capacity/sales checks if available, otherwise fall back to ticket type
    const capacitySource = pricingTier || ticketType;

    const now = new Date();
    if (capacitySource.salesStart && new Date(capacitySource.salesStart) > now) {
      apiLogger.warn({ msg: "public/register:sales-not-started", eventId: event.id, ticketTypeId, pricingTierId });
      return NextResponse.json(
        { error: "Registration sales have not started" },
        { status: 400 }
      );
    }
    if (capacitySource.salesEnd && new Date(capacitySource.salesEnd) < now) {
      apiLogger.warn({ msg: "public/register:sales-ended", eventId: event.id, ticketTypeId, pricingTierId });
      return NextResponse.json(
        { error: "Registration sales have ended" },
        { status: 400 }
      );
    }

    // Early check (non-authoritative — the real check is inside the transaction).
    // Virtual is uncapped, so a sold-out venue can still take virtual signups.
    if (!isVirtual && capacitySource.soldCount >= capacitySource.quantity) {
      apiLogger.warn({ msg: "public/register:sold-out", eventId: event.id, ticketTypeId, pricingTierId });
      return NextResponse.json({ error: "Sold out" }, { status: 400 });
    }

    // Event-wide cap pre-check (non-authoritative — the atomic claim is inside
    // the transaction). Virtual never consumes the event cap.
    if (!isVirtual && event.maxAttendees != null && event.seatCount >= event.maxAttendees) {
      apiLogger.warn({ msg: "public/register:event-full", eventId: event.id, maxAttendees: event.maxAttendees });
      return NextResponse.json({ error: "This event is fully booked" }, { status: 400 });
    }

    // Derive registrationType from the selected ticket type name
    const registrationType = ticketType.name;
    const regTypeLower = registrationType.toLowerCase();

    // Validate conditional required fields
    if (regTypeLower.includes("member") && !memberId?.trim()) {
      apiLogger.warn({ msg: "Member registration missing memberId", email, registrationType });
      return NextResponse.json({ error: "Member ID is required for member registration" }, { status: 400 });
    }
    if (regTypeLower.includes("student")) {
      if (!studentId?.trim()) {
        apiLogger.warn({ msg: "Student registration missing studentId", email, registrationType });
        return NextResponse.json({ error: "Student ID is required for student registration" }, { status: 400 });
      }
      if (!studentIdExpiry?.trim()) {
        apiLogger.warn({ msg: "Student registration missing studentIdExpiry", email, registrationType });
        return NextResponse.json({ error: "Student ID expiry date is required for student registration" }, { status: 400 });
      }
      // Validate date format
      if (isNaN(new Date(studentIdExpiry).getTime())) {
        apiLogger.warn({ msg: "Invalid studentIdExpiry date", email, studentIdExpiry });
        return NextResponse.json({ error: "Invalid student ID expiry date" }, { status: 400 });
      }
    }

    // Supporting document. Whether one is asked for is a property of the
    // TICKET TYPE the registrant picked (organizer switch), not of its name.
    //
    // The path comes from the client, so its shape is checked before it is
    // stored — the staff download route later resolves this value against the
    // filesystem, and a stored `../../` would be an arbitrary-read primitive.
    // Anything that is not a path our own upload route produced is DROPPED
    // (not 400'd): a malformed value can only come from a tampered request,
    // and failing the whole registration would punish the honest case where a
    // proxy mangled the field.
    const needsDocument = requiresSupportingDocument(ticketType);
    // Fall back to the pre-rename field names (see the schema note above).
    const documentUrl = supportingDocumentUrl ?? validated.data.residentLetterUrl;
    const documentFilename =
      supportingDocumentFilename ?? validated.data.residentLetterFilename;
    if (!supportingDocumentUrl && validated.data.residentLetterUrl) {
      apiLogger.warn({
        msg: "public/register:legacy-document-field-used",
        eventId: event.id,
        note: "pre-Aug-13 browser bundle; safe to remove the alias once this stops appearing",
      });
    }
    let letterUrl: string | null = null;
    let letterFilename: string | null = null;
    if (needsDocument && documentUrl) {
      // Shape AND ownership: the path's {eventId} segment must be the event
      // being registered for. Without this an anonymous POST can point this
      // registration at ANOTHER event's file (no upload needed — just a known
      // filename), and that event's own staff would then stream it from their
      // detail sheet.
      if (
        isSupportingDocumentPath(documentUrl) &&
        documentUrl.startsWith(`${SUPPORTING_DOCUMENT_PATH_PREFIX}${event.id}/`)
      ) {
        letterUrl = documentUrl;
        letterFilename = documentFilename?.trim() || null;
      } else {
        apiLogger.warn({
          msg: "public/register:supporting-document-path-rejected",
          eventId: event.id,
          email,
          supportingDocumentUrl: documentUrl,
        });
      }
    } else if (documentUrl) {
      // A document was attached for a type that does not ask for one — the
      // registrant uploaded, then changed their registration type. Dropping it
      // is right, but it was the ONE drop in this flow with no log at all, so
      // an organizer chasing "they said they uploaded it" had nothing to find.
      apiLogger.warn({
        msg: "public/register:supporting-document-dropped-type-not-asking",
        eventId: event.id,
        email,
        ticketTypeId,
      });
    }
    if (needsDocument && !letterUrl && supportingDocumentBlocks(ticketType)) {
      apiLogger.warn({
        msg: "public/register:supporting-document-missing",
        eventId: event.id,
        email,
        registrationType,
      });
      return NextResponse.json(
        {
          error: `${supportingDocumentLabel(ticketType)} is required for this registration type.`,
          code: "SUPPORTING_DOCUMENT_REQUIRED",
        },
        { status: 400 },
      );
    }

    // Atomic transaction: attendee create + duplicate check + soldCount increment + registration create
    const result = await tenantTransaction(async (tx) => {
      // Check if already registered (same email + same event)
      const existingRegistration = await tx.registration.findFirst({
        where: {
          eventId: event.id,
          attendee: { email },
          status: { notIn: ["CANCELLED"] },
        },
        select: { id: true },
      });
      if (existingRegistration) {
        throw new Error("ALREADY_REGISTERED");
      }

      // Reuse orphaned attendee (left behind after registration deletion) or create new
      const attendeeData = {
        organizationId: event.organizationId,
        title,
        role,
        email,
        firstName,
        lastName,
        additionalEmail: additionalEmail || null,
        organization: organization || null,
        jobTitle: jobTitle || null,
        phone: phone || null,
        city: city || null,
        state: state || null,
        zipCode: zipCode || null,
        country,
        specialty,
        customSpecialty: customSpecialty || null,
        registrationType,
        dietaryReqs: dietaryReqs || null,
        associationName: associationName || null,
        memberId: memberId || null,
        studentId: studentId || null,
        studentIdExpiry: studentIdExpiry ? new Date(studentIdExpiry) : null,
      };

      // Look for an existing attendee with no active registration (orphaned).
      // Org-bound: cross-tenant orphan adoption previously let one tenant
      // overwrite another tenant's attendee PII via a shared email; NULL-org
      // orphans simply no longer match and a fresh row is minted.
      const existingAttendee = await tx.attendee.findFirst({
        where: {
          email,
          organizationId: event.organizationId,
          registrations: { none: {} },
        },
        select: { id: true },
      });

      const attendee = existingAttendee
        ? await tx.attendee.update({
            where: { id: existingAttendee.id },
            data: attendeeData,
          })
        : await tx.attendee.create({ data: attendeeData });

      // Atomically increment soldCount on the correct capacity source.
      // Virtual is uncapped → no increment, no sold-out guard (physical seats
      // are unaffected by online attendees).
      if (!isVirtual) {
        if (pricingTier) {
          const updated = await tx.pricingTier.updateMany({
            where: { id: pricingTier.id, soldCount: { lt: pricingTier.quantity } },
            data: { soldCount: { increment: 1 } },
          });
          if (updated.count === 0) throw new Error("SOLD_OUT");
        } else {
          const updated = await tx.ticketType.updateMany({
            where: { id: ticketTypeId, soldCount: { lt: ticketType.quantity } },
            data: { soldCount: { increment: 1 } },
          });
          if (updated.count === 0) throw new Error("SOLD_OUT");
        }
        // Event-wide cap (Event.maxAttendees): an in-person public registration
        // also holds an event seat. Atomic conditional claim in the same tx —
        // null maxAttendees (the default) never blocks.
        const eventClaimed = await claimEventSeats(tx, event.id);
        if (!eventClaimed) throw new Error("EVENT_FULL");
      }

      // Virtual uses the ticket's flat virtualPrice (null ⇒ in-person price);
      // pricing tiers apply to in-person only.
      const originalPrice = isVirtual
        ? Number(ticketType.virtualPrice ?? ticketType.price)
        : pricingTier
          ? Number(pricingTier.price)
          : Number(ticketType.price);
      const effectiveApproval = pricingTier ? pricingTier.requiresApproval : ticketType.requiresApproval;

      // Promo code validation and redemption (inside transaction for atomicity)
      let discountAmount = 0;
      let promoCodeRecord: { id: string; code: string; discountType: string; discountValue: unknown } | null = null;

      if (promoCode) {
        const promo = await tx.promoCode.findUnique({
          where: { eventId_code: { eventId: event.id, code: promoCode.toUpperCase().trim() } },
          include: { ticketTypes: { select: { ticketTypeId: true } } },
        });

        if (!promo || !promo.isActive) throw new Error("INVALID_PROMO_CODE");

        const now2 = new Date();
        if (promo.validFrom && now2 < promo.validFrom) throw new Error("INVALID_PROMO_CODE");
        if (promo.validUntil && now2 > promo.validUntil) throw new Error("INVALID_PROMO_CODE");

        // Ticket type applicability
        if (promo.ticketTypes.length > 0) {
          if (!promo.ticketTypes.some((t: { ticketTypeId: string }) => t.ticketTypeId === ticketTypeId))
            throw new Error("PROMO_CODE_NOT_APPLICABLE");
        }

        // Serialize concurrent applies of this promo so the per-email
        // count→insert below can't race past a maxUsesPerEmail cap (two
        // near-simultaneous registrations on the same email + code). Tx-scoped
        // row lock, auto-released at commit; same fix as the promo-code-service.
        await tx.$queryRaw`SELECT id FROM "PromoCode" WHERE id = ${promo.id} FOR UPDATE`;

        // Per-email limit FIRST (July-1 review LOW): checking before the
        // usedCount increment means the counter never moves for a rejected
        // apply. Inside this $transaction a throw rolled the increment back
        // anyway, but the old order was one non-transactional refactor away
        // from leaking usedCount on every EMAIL_LIMIT rejection.
        if (promo.maxUsesPerEmail !== null) {
          const emailUses = await tx.promoCodeRedemption.count({
            where: { promoCodeId: promo.id, email },
          });
          if (emailUses >= promo.maxUsesPerEmail) throw new Error("PROMO_CODE_EMAIL_LIMIT");
        }

        // Atomic usedCount increment (same pattern as soldCount)
        if (promo.maxUses !== null) {
          const updated = await tx.promoCode.updateMany({
            where: { id: promo.id, usedCount: { lt: promo.maxUses } },
            data: { usedCount: { increment: 1 } },
          });
          if (updated.count === 0) throw new Error("PROMO_CODE_EXHAUSTED");
        } else {
          await tx.promoCode.update({
            where: { id: promo.id },
            data: { usedCount: { increment: 1 } },
          });
        }

        // Calculate discount. Same defensive clamp as promo-code-service: bad
        // stored data (negative value / percentage > 100) never yields a
        // surcharge or a discount above the base price.
        const promoValue = Number(promo.discountValue);
        if (promo.discountType === "PERCENTAGE") {
          discountAmount = originalPrice * Math.min(100, Math.max(0, promoValue)) / 100;
        } else {
          discountAmount = Math.min(Math.max(0, promoValue), originalPrice);
        }
        discountAmount = Math.round(discountAmount * 100) / 100;
        promoCodeRecord = promo;
      }

      const finalPrice = Math.max(0, originalPrice - discountAmount);

      // Create registration. Virtual ⇒ no entry barcode (nothing to scan).
      const generatedBarcode = isVirtual ? null : generateBarcode();
      const serialId = await getNextSerialId(tx, event.id, event.organizationId);
      const registration = await tx.registration.create({
        data: {
          organizationId: event.organizationId,
          eventId: event.id,
          ticketTypeId,
          pricingTierId: isVirtual ? null : pricingTier?.id || null,
          attendeeId: attendee.id,
          serialId,
          attendanceMode,
          createdSource: "PUBLIC_REGISTER",
          status: effectiveApproval ? "PENDING" : "CONFIRMED",
          // A zero-price registration (free ticket, or a promo code that
          // discounts to 0) never goes through Stripe, so PAID is the wrong
          // signal — there was no payment. COMPLIMENTARY is the correct
          // "no money due" status, consistent with the service layer's
          // free-ticket default and the CSV import path.
          paymentStatus: finalPrice === 0 ? "COMPLIMENTARY" : "UNPAID",
          qrCode: generatedBarcode,
          promoCodeId: promoCodeRecord?.id || null,
          discountAmount: discountAmount > 0 ? discountAmount : null,
          // Always stamp the resolved base price (incl. virtual pricing), not
          // only when discounted — the authoritative subtotal for every read
          // surface, so tier-priced / VIRTUAL regs never resolve to 0.
          originalPrice,
          referrer: referrer || null,
          utmSource: utmSource || null,
          utmMedium: utmMedium || null,
          utmCampaign: utmCampaign || null,
          supportingDocumentUrl: letterUrl,
          supportingDocumentFilename: letterFilename,
          taxNumber: taxNumber || null,
          billingFirstName: billingFirstName || null,
          billingLastName: billingLastName || null,
          billingEmail: billingEmail || null,
          billingPhone: billingPhone || null,
          billingAddress: billingAddress || null,
          billingCity: billingCity || null,
          billingState: billingState || null,
          billingZipCode: billingZipCode || null,
          billingCountry: billingCountry || null,
        },
        include: { attendee: true, ticketType: true, pricingTier: true },
      });

      // Create promo code redemption record
      if (promoCodeRecord && discountAmount > 0) {
        await tx.promoCodeRedemption.create({
          data: {
            promoCodeId: promoCodeRecord.id,
            organizationId: event.organizationId,
            registrationId: registration.id,
            email,
            originalPrice,
            discountAmount,
            finalPrice,
          },
        });
      }

      return { registration, discountAmount, originalPrice, finalPrice, appliedPromoCode: promoCodeRecord?.code ?? null };
    });

    const {
      registration,
      discountAmount: appliedDiscount,
      finalPrice: registrationFinalPrice,
      originalPrice: registrationOriginalPrice,
      appliedPromoCode,
    } = result;

    // Notify admins/organizers (non-blocking)
    notifyEventAdmins(event.id, {
      type: "REGISTRATION",
      title: "New Registration",
      setting: "notifyOnRegistration" as const,
      message: `${firstName} ${lastName} registered as ${registrationType}`,
      link: `/events/${event.id}/registrations`,
    }).catch((err) => apiLogger.error({ err, msg: "Failed to send registration notification" }));

    // Log audit entry (non-blocking)
    db.auditLog.create({
      data: {
        eventId: event.id,
        action: "CREATE",
        entityType: "Registration",
        entityId: registration.id,
        changes: {
          source: "public_registration",
          confirmationNumber: registration.id,
          attendee: { firstName, lastName, email },
          ticketType: registrationType,
          pricingTier: pricingTier ? pricingTier.name : null,
          status: registration.status,
          ip: getClientIp(req),
        },
      },
    }).catch((err) => apiLogger.error({ err, msg: "Failed to create audit log for public registration" }));

    // Sync to org contact store (awaited — errors caught internally)
    await syncToContact({
      organizationId: event.organizationId,
      eventId: event.id,
      email,
      firstName,
      lastName,
      title: title || null,
      role: role || null,
      additionalEmail: additionalEmail || null,
      organization: organization || null,
      jobTitle: jobTitle || null,
      phone: phone || null,
      city: city || null,
      state: state || null,
      zipCode: zipCode || null,
      country: country || null,
      specialty: specialty || null,
      customSpecialty: customSpecialty || null,
      registrationType,
      associationName: associationName || null,
      memberId: memberId || null,
      studentId: studentId || null,
      studentIdExpiry: studentIdExpiry ? new Date(studentIdExpiry) : null,
    });

    // Hand this registration a spare DTCM code, if the event is a Dubai one and
    // the organiser has imported a pool. Awaited (the confirmation email and the
    // badge both want it present) but structurally unable to fail the
    // registration — see claimSpareDtcmCode's contract.
    await claimSpareDtcmCode({
      eventId: event.id,
      registrationId: registration.id,
      requiresDtcm: !!event.requiresDtcmBarcode,
    });

    // Refresh denormalized event stats (fire-and-forget)
    refreshEventStats(event.id);

    // Account creation: create or link the REGISTRANT account + sweep any
    // sibling registrations on this email (failure-isolated — never blocks the
    // registration). No-ops when no password was supplied (guest registration).
    await ensureRegistrantAccount({
      registrationId: registration.id,
      eventId: event.id,
      organizationId: event.organizationId,
      email,
      firstName,
      lastName,
      password,
      specialty: specialty || null,
      clientIp: getClientIp(req),
      signupMessage: `${firstName} ${lastName} (${email}) created a registrant account`,
    });

    const finalPrice = registrationFinalPrice;
    const finalCurrency = pricingTier ? pricingTier.currency : ticketType.currency;
    const tierLabel = pricingTier ? `${ticketType.name} (${pricingTier.name})` : ticketType.name;

    // Send confirmation email.
    // WEBINAR events get the webinar-confirmation template (with join URL +
    // passcode, no PDF quote). All other event types get the standard
    // registration confirmation with PDF quote attached.
    if (event.eventType === "WEBINAR") {
      try {
        await sendWebinarConfirmationForRegistration({
          eventId: event.id,
          registrationId: registration.id,
          organizerName: event.organization.name,
          organizerEmail: event.supportEmail || "",
        });
      } catch (emailError) {
        apiLogger.error(
          { err: emailError, msg: "Failed to send webinar confirmation email", registrationId: registration.id },
        );
      }
    } else {
      try {
        await sendRegistrationConfirmation({
          ...buildEventConfirmationFields(event),
          to: email,
          additionalEmail: additionalEmail || null,
          firstName,
          lastName,
          title: title || null,
          organization: organization || null,
          attendanceMode,
          ticketType: tierLabel,
          pricingTierName: pricingTier?.name || null,
          registrationId: registration.id,
          serialId: registration.serialId,
          qrCode: registration.qrCode || "",
          eventSlug: slug,
          // Base price + discount (not the pre-discounted finalPrice) so the
          // email's payment breakdown itemises the promo and taxes the net —
          // matching the attached quote + the Stripe charge.
          ticketPrice: registrationOriginalPrice,
          ticketCurrency: finalCurrency,
          discountAmount: appliedDiscount,
          promoCode: appliedPromoCode,
          billingFirstName: registration.billingFirstName,
          billingLastName: registration.billingLastName,
          billingEmail: registration.billingEmail,
          billingPhone: registration.billingPhone,
          billingAddress: registration.billingAddress,
          billingCity: registration.billingCity,
          billingState: registration.billingState,
          billingZipCode: registration.billingZipCode,
          billingCountry: registration.billingCountry,
          taxNumber: registration.taxNumber,
          jobTitle: jobTitle || null,
        });
      } catch (emailError) {
        apiLogger.error({ err: emailError, msg: "Failed to send confirmation email" });
      }
    }

    // INTENTIONALLY no invoice auto-creation here.
    //   - Pre-payment, the registrant already received the Quote PDF as
    //     an attachment on the confirmation email (via
    //     `sendRegistrationConfirmation` → attaches `generateQuotePDF`).
    //   - Post-payment, the Stripe webhook creates the Invoice
    //     (type=INVOICE, status=PAID) via `createPaidInvoice` +
    //     `sendInvoiceEmail`. Stripe sends its own receipt email
    //     separately — ours is the system invoice.
    //   - A formal INVOICE row issued BEFORE payment is an
    //     admin-triggered artifact from the dashboard
    //     /events/[id]/invoices page only, never auto-generated
    //     at registration time. Organizer reported the old auto-call
    //     as confusing — the registrant saw a sent invoice before
    //     they'd paid.

    return NextResponse.json(
      {
        success: true,
        registration: {
          id: registration.id,
          serialId: registration.serialId,
          status: registration.status,
          paymentStatus: registration.paymentStatus,
          qrCode: registration.qrCode,
          ticketType: ticketType.name,
          pricingTier: pricingTier ? pricingTier.name : null,
          ticketPrice: finalPrice,
          ticketCurrency: finalCurrency,
          discountAmount: appliedDiscount > 0 ? appliedDiscount : null,
          promoCode: promoCode || null,
          attendee: {
            firstName,
            lastName,
            email,
          },
        },
        event: {
          name: event.name,
          startDate: event.startDate,
          venue: event.venue,
          city: event.city,
        },
      },
      { status: 201 }
    );
    });
  } catch (error) {
    if (error instanceof Error) {
      // M12: the sentinel-mapped business 400s (duplicate / sold-out / promo
      // rejections) were returned dark — log each at warn so a failed public
      // registration is traceable without asking the registrant.
      const businessRejections = [
        "ALREADY_REGISTERED",
        "SOLD_OUT",
        "EVENT_FULL",
        "INVALID_PROMO_CODE",
        "PROMO_CODE_NOT_APPLICABLE",
        "PROMO_CODE_EXHAUSTED",
        "PROMO_CODE_EMAIL_LIMIT",
      ];
      if (businessRejections.includes(error.message)) {
        apiLogger.warn({ msg: "public/register:business-rejection", code: error.message, slug: slugForLog });
      }
      if (error.message === "ALREADY_REGISTERED") {
        return NextResponse.json(
          { error: "You are already registered for this event" },
          { status: 400 }
        );
      }
      if (error.message === "SOLD_OUT") {
        return NextResponse.json(
          { error: "Tickets sold out" },
          { status: 400 }
        );
      }
      if (error.message === "EVENT_FULL") {
        return NextResponse.json(
          { error: "This event is fully booked" },
          { status: 400 }
        );
      }
      if (error.message === "INVALID_PROMO_CODE") {
        return NextResponse.json(
          { error: "Invalid or expired promo code" },
          { status: 400 }
        );
      }
      if (error.message === "PROMO_CODE_NOT_APPLICABLE") {
        return NextResponse.json(
          { error: "Promo code not applicable to this ticket type" },
          { status: 400 }
        );
      }
      if (error.message === "PROMO_CODE_EXHAUSTED") {
        return NextResponse.json(
          { error: "Promo code usage limit reached" },
          { status: 400 }
        );
      }
      if (error.message === "PROMO_CODE_EMAIL_LIMIT") {
        return NextResponse.json(
          { error: "Promo code already used with this email" },
          { status: 400 }
        );
      }
    }
    // Handle Prisma unique constraint on attendee email (P2002)
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: string }).code === "P2002"
    ) {
      return NextResponse.json(
        { error: "You are already registered for this event" },
        { status: 400 }
      );
    }
    apiLogger.error({ err: error, msg: "Error creating public registration" });
    return NextResponse.json(
      { error: "Failed to complete registration" },
      { status: 500 }
    );
  }
}
