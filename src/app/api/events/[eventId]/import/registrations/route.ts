import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { checkRateLimit } from "@/lib/security";
import { generateBarcode } from "@/lib/utils";
import { getNextSerialId } from "@/lib/registration-serial";
import { parseCSV, getField, parseTags } from "@/lib/csv-parser";
import { syncToContact } from "@/lib/contact-sync";
import { refreshEventStats } from "@/lib/event-stats";
import { readSponsors } from "@/lib/webinar";
import type { RegistrationStatus, PaymentStatus } from "@prisma/client";

const TITLE_VALUES = new Set(["MR", "MS", "MRS", "DR", "PROF"]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Admin-settable subsets — Stripe-driven payment states (PENDING / REFUNDED /
// FAILED) and LIVE-only registration states (CHECKED_IN) are excluded from
// the CSV import because they're driven by webhooks / scanner flows.
const ALLOWED_REGISTRATION_STATUSES = new Set<RegistrationStatus>([
  "PENDING",
  "CONFIRMED",
  "WAITLISTED",
  "CANCELLED",
]);
const ALLOWED_PAYMENT_STATUSES = new Set<PaymentStatus>([
  "UNASSIGNED",
  "UNPAID",
  "PAID",
  "COMPLIMENTARY",
  "INCLUSIVE",
]);

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const rateLimit = checkRateLimit({
      key: `import-registrations:org:${session.user.organizationId}`,
      limit: 10,
      windowMs: 60 * 60 * 1000,
    });
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { error: "Import limit reached. Maximum 10 imports per hour." },
        { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } }
      );
    }

    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    const text = await file.text();
    const { headers, rows, error: parseError } = parseCSV(text);
    if (parseError) {
      return NextResponse.json({ error: parseError }, { status: 400 });
    }

    // Build column index. The three trailing columns (registrationStatus,
    // paymentStatus, sponsor) are optional — when absent the import retains
    // its prior behavior (status defaults to CONFIRMED-or-PENDING based on
    // requiresApproval, paymentStatus defaults to COMPLIMENTARY-for-free
    // or UNASSIGNED-for-paid, sponsorId left null).
    const idx = {
      email: headers.indexOf("email"),
      firstName: headers.indexOf("firstname"),
      lastName: headers.indexOf("lastname"),
      organization: headers.indexOf("organization"),
      jobTitle: headers.indexOf("jobtitle"),
      phone: headers.indexOf("phone"),
      city: headers.indexOf("city"),
      state: headers.indexOf("state"),
      zipCode: headers.indexOf("zipcode"),
      country: headers.indexOf("country"),
      specialty: headers.indexOf("specialty"),
      registrationType: headers.indexOf("registrationtype"),
      tags: headers.indexOf("tags"),
      bio: headers.indexOf("bio"),
      dietaryReqs: headers.indexOf("dietaryreqs"),
      notes: headers.indexOf("notes"),
      title: headers.indexOf("title"),
      associationName: headers.indexOf("associationname"),
      memberId: headers.indexOf("memberid"),
      studentId: headers.indexOf("studentid"),
      registrationStatus: headers.indexOf("registrationstatus"),
      paymentStatus: headers.indexOf("paymentstatus"),
      sponsor: headers.indexOf("sponsor"),
      attendanceMode: headers.indexOf("attendancemode"),
    };

    if (idx.email === -1 || idx.firstName === -1 || idx.lastName === -1) {
      return NextResponse.json(
        { error: "CSV must have email, firstName, and lastName columns" },
        { status: 400 }
      );
    }

    // Verify event belongs to org, and pull settings so sponsor names in the
    // CSV can be resolved against Event.settings.sponsors[] without N+1.
    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: session.user.organizationId! },
      select: { id: true, settings: true },
    });
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    // Build a case-insensitive sponsor-name → id map. Collect colliding
    // names so we can reject ambiguous matches in the per-row loop
    // (silently picking the "first match" would corrupt money attribution
    // when two sponsors share a name prefix).
    const sponsorList = readSponsors(event.settings);
    const sponsorByName = new Map<string, { id: string; name: string }>();
    const ambiguousNames = new Set<string>();
    for (const s of sponsorList) {
      const key = s.name.trim().toLowerCase();
      if (sponsorByName.has(key)) ambiguousNames.add(key);
      else sponsorByName.set(key, { id: s.id, name: s.name });
    }

    apiLogger.info({ msg: "Import started", importType: "registrations", source: "csv", eventId, userId: session.user.id, rowCount: rows.length });

    const errors: string[] = [];
    const createdIds: string[] = [];
    let created = 0;
    let skipped = 0;

    // Cache ticket types by name for registrationType matching
    const ticketTypes = await db.ticketType.findMany({
      where: { eventId, isActive: true },
      select: { id: true, name: true, quantity: true, soldCount: true, requiresApproval: true, price: true },
    });
    const ticketTypeByName = new Map(ticketTypes.map((tt) => [tt.name.toLowerCase(), tt]));

    // Get or create a default ticket type for rows without registrationType
    let defaultTicketType = ticketTypes[0];
    if (!defaultTicketType) {
      defaultTicketType = await db.ticketType.create({
        data: {
          eventId,
          name: "General",
          price: 0,
          quantity: 999999,
          isActive: true,
        },
      });
    }

    for (let i = 0; i < rows.length; i++) {
      const fields = rows[i];
      const rowNum = i + 2; // 1-indexed, skip header

      const email = getField(fields, idx.email)?.toLowerCase();
      const firstName = getField(fields, idx.firstName);
      const lastName = getField(fields, idx.lastName);

      if (!email || !firstName || !lastName) {
        errors.push(`Row ${rowNum}: missing required fields (email, firstName, lastName)`);
        continue;
      }

      if (!EMAIL_RE.test(email)) {
        errors.push(`Row ${rowNum}: invalid email "${email}"`);
        continue;
      }

      const titleRaw = getField(fields, idx.title)?.toUpperCase();
      const title = titleRaw && TITLE_VALUES.has(titleRaw) ? titleRaw : null;
      const registrationType = getField(fields, idx.registrationType);
      const tags = parseTags(getField(fields, idx.tags));

      // Per-row registrationStatus + paymentStatus + sponsor. Each cell is
      // optional; defaults match the prior behavior so existing CSV
      // templates keep working unchanged.
      const rowRegistrationStatusRaw = getField(fields, idx.registrationStatus)?.toUpperCase();
      let rowRegistrationStatus: RegistrationStatus | null = null;
      if (rowRegistrationStatusRaw) {
        if (!ALLOWED_REGISTRATION_STATUSES.has(rowRegistrationStatusRaw as RegistrationStatus)) {
          errors.push(
            `Row ${rowNum}: invalid registrationStatus "${rowRegistrationStatusRaw}" (allowed: ${[...ALLOWED_REGISTRATION_STATUSES].join(", ")})`,
          );
          continue;
        }
        rowRegistrationStatus = rowRegistrationStatusRaw as RegistrationStatus;
      }

      const rowPaymentStatusRaw = getField(fields, idx.paymentStatus)?.toUpperCase();
      let rowPaymentStatus: PaymentStatus | null = null;
      if (rowPaymentStatusRaw) {
        if (!ALLOWED_PAYMENT_STATUSES.has(rowPaymentStatusRaw as PaymentStatus)) {
          errors.push(
            `Row ${rowNum}: invalid paymentStatus "${rowPaymentStatusRaw}" (allowed: ${[...ALLOWED_PAYMENT_STATUSES].join(", ")})`,
          );
          continue;
        }
        rowPaymentStatus = rowPaymentStatusRaw as PaymentStatus;
      }

      // Sponsor resolution. Case-insensitive name match against
      // Event.settings.sponsors[]; ambiguous matches are rejected so a
      // typo can't silently attribute money to the wrong sponsor.
      const sponsorRaw = getField(fields, idx.sponsor)?.trim();
      let rowSponsorId: string | null = null;
      if (sponsorRaw) {
        const key = sponsorRaw.toLowerCase();
        if (ambiguousNames.has(key)) {
          errors.push(
            `Row ${rowNum}: ambiguous sponsor name "${sponsorRaw}" — multiple sponsors match. Use the exact full name.`,
          );
          continue;
        }
        const match = sponsorByName.get(key);
        if (!match) {
          const available = [...sponsorByName.values()].map((s) => s.name).join(", ") || "(none)";
          errors.push(
            `Row ${rowNum}: sponsor "${sponsorRaw}" not found. Available: ${available}. Add the sponsor on the event's Sponsors page first.`,
          );
          continue;
        }
        rowSponsorId = match.id;
      }
      if (rowPaymentStatus === "INCLUSIVE" && !rowSponsorId) {
        errors.push(
          `Row ${rowNum}: paymentStatus=INCLUSIVE requires a sponsor column with the sponsor's name.`,
        );
        continue;
      }

      // Attendance mode (optional column; defaults IN_PERSON). VIRTUAL ⇒ no
      // qrCode/badge and uncapped (skips the seat count), matching the
      // registration service + public-register behavior.
      const rowModeRaw = getField(fields, idx.attendanceMode)?.toUpperCase().replace(/[\s-]/g, "_");
      let rowAttendanceMode: "IN_PERSON" | "VIRTUAL" = "IN_PERSON";
      if (rowModeRaw) {
        if (rowModeRaw !== "IN_PERSON" && rowModeRaw !== "VIRTUAL") {
          errors.push(`Row ${rowNum}: invalid attendanceMode "${rowModeRaw}" (allowed: IN_PERSON, VIRTUAL)`);
          continue;
        }
        rowAttendanceMode = rowModeRaw;
      }
      const rowIsVirtual = rowAttendanceMode === "VIRTUAL";

      // Find matching ticket type
      let ticketType = defaultTicketType;
      if (registrationType) {
        const match = ticketTypeByName.get(registrationType.toLowerCase());
        if (match) {
          ticketType = match;
        } else {
          // Create a new ticket type for this registration type
          const newTT = await db.ticketType.create({
            data: { eventId, name: registrationType, price: 0, quantity: 999999, isActive: true },
          });
          ticketTypeByName.set(registrationType.toLowerCase(), newTT);
          ticketType = newTT;
        }
      }

      try {
        const newRegId = await db.$transaction(async (tx) => {
          // Check for duplicate registration (same email + same event)
          const existing = await tx.registration.findFirst({
            where: { eventId, attendee: { email }, status: { notIn: ["CANCELLED"] } },
            select: { id: true },
          });
          if (existing) {
            throw new Error("ALREADY_REGISTERED");
          }

          // Create a new attendee record for this registration
          const attendee = await tx.attendee.create({
            data: {
              email,
              firstName,
              lastName,
              title: title as "MR" | "MS" | "MRS" | "DR" | "PROF" | null,
              organization: getField(fields, idx.organization) || null,
              jobTitle: getField(fields, idx.jobTitle) || null,
              phone: getField(fields, idx.phone) || null,
              city: getField(fields, idx.city) || null,
              state: getField(fields, idx.state) || null,
              zipCode: getField(fields, idx.zipCode) || null,
              country: getField(fields, idx.country) || null,
              bio: getField(fields, idx.bio) || null,
              specialty: getField(fields, idx.specialty) || null,
              registrationType: registrationType || null,
              associationName: getField(fields, idx.associationName) || null,
              memberId: getField(fields, idx.memberId) || null,
              studentId: getField(fields, idx.studentId) || null,
              tags,
              dietaryReqs: getField(fields, idx.dietaryReqs) || null,
            },
          });

          // Check capacity and increment soldCount — skipped for virtual
          // (uncapped; online attendees don't consume physical seats).
          if (!rowIsVirtual) {
            const currentTicket = await tx.ticketType.findUnique({
              where: { id: ticketType.id },
              select: { quantity: true, soldCount: true },
            });
            if (currentTicket && currentTicket.soldCount >= currentTicket.quantity) {
              throw new Error("CAPACITY_EXCEEDED");
            }
            await tx.ticketType.update({
              where: { id: ticketType.id },
              data: { soldCount: { increment: 1 } },
            });
          }

          // Virtual ⇒ no entry barcode.
          const generatedBarcode = rowIsVirtual ? null : generateBarcode();
          const serialId = await getNextSerialId(tx, eventId);
          // Per-row registrationStatus / paymentStatus overrides fall back to
          // the prior defaults when the CSV columns are absent. requiresApproval
          // still beats CONFIRMED-by-default but a CSV explicit
          // registrationStatus wins over it (admin's call to override is
          // intentional).
          const defaultStatus: RegistrationStatus = ticketType.requiresApproval ? "PENDING" : "CONFIRMED";
          const defaultPaymentStatus: PaymentStatus =
            Number(ticketType.price) === 0 ? "COMPLIMENTARY" : "UNASSIGNED";
          const registration = await tx.registration.create({
            data: {
              eventId,
              ticketTypeId: ticketType.id,
              attendeeId: attendee.id,
              serialId,
              createdSource: "CSV_IMPORT",
              status: rowRegistrationStatus ?? defaultStatus,
              paymentStatus: rowPaymentStatus ?? defaultPaymentStatus,
              attendanceMode: rowAttendanceMode,
              sponsorId: rowSponsorId,
              qrCode: generatedBarcode,
              notes: getField(fields, idx.notes) || null,
            },
            select: { id: true },
          });
          return registration.id;
        });
        createdIds.push(newRegId);
        created++;

        // Sync to contact store (awaited — errors caught internally)
        await syncToContact({
          organizationId: session.user.organizationId!,
          eventId,
          email,
          firstName,
          lastName,
          title: title as string | null,
          organization: getField(fields, idx.organization) || null,
          jobTitle: getField(fields, idx.jobTitle) || null,
          phone: getField(fields, idx.phone) || null,
          city: getField(fields, idx.city) || null,
          state: getField(fields, idx.state) || null,
          zipCode: getField(fields, idx.zipCode) || null,
          country: getField(fields, idx.country) || null,
          bio: getField(fields, idx.bio) || null,
          specialty: getField(fields, idx.specialty) || null,
          registrationType: registrationType || null,
          associationName: getField(fields, idx.associationName) || null,
          memberId: getField(fields, idx.memberId) || null,
          studentId: getField(fields, idx.studentId) || null,
        });
      } catch (err) {
        if (err instanceof Error && err.message === "ALREADY_REGISTERED") {
          skipped++;
        } else if (err instanceof Error && err.message === "CAPACITY_EXCEEDED") {
          errors.push(`Row ${rowNum}: registration type is at full capacity`);
        } else {
          apiLogger.error({ msg: "Unexpected error importing registration row", rowNum, error: err instanceof Error ? err.message : "Unknown" });
          errors.push(`Row ${rowNum}: ${err instanceof Error ? err.message : "unknown error"}`);
        }
      }
    }

    // Refresh denormalized event stats (fire-and-forget)
    refreshEventStats(eventId);

    apiLogger.info({ msg: "Import complete", importType: "registrations", source: "csv", eventId, userId: session.user.id, created, skipped, errorCount: errors.length });
    if (errors.length > 0) {
      apiLogger.warn({ msg: "Import errors", importType: "registrations", source: "csv", eventId, userId: session.user.id, errors: errors.slice(0, 50) });
    }

    return NextResponse.json({ created, skipped, errors, registrationIds: createdIds });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error importing registrations" });
    return NextResponse.json({ error: "Failed to import registrations" }, { status: 500 });
  }
}
