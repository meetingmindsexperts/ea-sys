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

const TITLE_VALUES = new Set(["MR", "MS", "MRS", "DR", "PROF"]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

    // Build column index
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
    };

    if (idx.email === -1 || idx.firstName === -1 || idx.lastName === -1) {
      return NextResponse.json(
        { error: "CSV must have email, firstName, and lastName columns" },
        { status: 400 }
      );
    }

    // Verify event belongs to org
    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: session.user.organizationId! },
      select: { id: true },
    });
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
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

          // Check capacity and increment soldCount
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

          const generatedBarcode = generateBarcode();
          const serialId = await getNextSerialId(tx, eventId);
          const registration = await tx.registration.create({
            data: {
              eventId,
              ticketTypeId: ticketType.id,
              attendeeId: attendee.id,
              serialId,
              status: ticketType.requiresApproval ? "PENDING" : "CONFIRMED",
              paymentStatus: Number(ticketType.price) === 0 ? "PAID" : "UNPAID",
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
