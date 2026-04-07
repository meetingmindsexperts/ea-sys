import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { checkRateLimit } from "@/lib/security";
import { parseCSV, getField, parseTags } from "@/lib/csv-parser";
import { syncManyToContacts } from "@/lib/contact-sync";

const TITLE_VALUES = new Set(["MR", "MS", "MRS", "DR", "PROF"]);
const SPEAKER_STATUS_VALUES = new Set(["INVITED", "CONFIRMED", "DECLINED", "CANCELLED"]);
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
      key: `import-speakers:org:${session.user.organizationId}`,
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

    const idx = {
      email: headers.indexOf("email"),
      firstName: headers.indexOf("firstname"),
      lastName: headers.indexOf("lastname"),
      organization: headers.indexOf("organization"),
      jobTitle: headers.indexOf("jobtitle"),
      phone: headers.indexOf("phone"),
      bio: headers.indexOf("bio"),
      city: headers.indexOf("city"),
      state: headers.indexOf("state"),
      zipCode: headers.indexOf("zipcode"),
      country: headers.indexOf("country"),
      specialty: headers.indexOf("specialty"),
      registrationType: headers.indexOf("registrationtype"),
      tags: headers.indexOf("tags"),
      website: headers.indexOf("website"),
      status: headers.indexOf("status"),
      title: headers.indexOf("title"),
      additionalEmail: headers.indexOf("additionalemail"),
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

    // Get existing speaker emails to detect duplicates
    const existingSpeakers = await db.speaker.findMany({
      where: { eventId },
      select: { email: true },
    });
    const existingEmails = new Set(existingSpeakers.map((s) => s.email.toLowerCase()));

    apiLogger.info({ msg: "Import started", importType: "speakers", source: "csv", eventId, userId: session.user.id, rowCount: rows.length });

    const errors: string[] = [];
    const speakers: Prisma.SpeakerCreateManyInput[] = [];

    for (let i = 0; i < rows.length; i++) {
      const fields = rows[i];
      const rowNum = i + 2;

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

      if (existingEmails.has(email)) {
        continue; // Skip duplicate silently — counted as skipped
      }

      const titleRaw = getField(fields, idx.title)?.toUpperCase();
      const title = titleRaw && TITLE_VALUES.has(titleRaw) ? titleRaw : null;
      const statusRaw = getField(fields, idx.status)?.toUpperCase();
      const status = statusRaw && SPEAKER_STATUS_VALUES.has(statusRaw) ? statusRaw : "INVITED";

      existingEmails.add(email); // Prevent duplicate within the same CSV

      speakers.push({
        eventId,
        email,
        firstName,
        lastName,
        title: title as "MR" | "MS" | "MRS" | "DR" | "PROF" | null,
        organization: getField(fields, idx.organization) || null,
        jobTitle: getField(fields, idx.jobTitle) || null,
        phone: getField(fields, idx.phone) || null,
        bio: getField(fields, idx.bio) || null,
        city: getField(fields, idx.city) || null,
        state: getField(fields, idx.state) || null,
        zipCode: getField(fields, idx.zipCode) || null,
        country: getField(fields, idx.country) || null,
        specialty: getField(fields, idx.specialty) || null,
        registrationType: getField(fields, idx.registrationType) || null,
        tags: parseTags(getField(fields, idx.tags)),
        website: getField(fields, idx.website) || null,
        additionalEmail: getField(fields, idx.additionalEmail) || null,
        status: status as "INVITED" | "CONFIRMED" | "DECLINED" | "CANCELLED",
      });
    }

    if (speakers.length === 0) {
      const skipped = rows.length - errors.length;
      apiLogger.info({ msg: "Import complete", importType: "speakers", source: "csv", eventId, userId: session.user.id, created: 0, skipped, errorCount: errors.length });
      if (errors.length > 0) {
        apiLogger.warn({ msg: "Import errors", importType: "speakers", source: "csv", eventId, userId: session.user.id, errors: errors.slice(0, 50) });
      }
      return NextResponse.json({ created: 0, skipped, errors });
    }

    const result = await db.speaker.createMany({
      data: speakers,
      skipDuplicates: true,
    });

    // Sync imported speakers to org contact store (fire-and-forget)
    syncManyToContacts(
      speakers.map((s) => ({
        organizationId: session.user.organizationId!,
        eventId,
        email: s.email,
        firstName: s.firstName,
        lastName: s.lastName,
        title: s.title,
        organization: s.organization,
        jobTitle: s.jobTitle,
        phone: s.phone,
        city: s.city,
        country: s.country,
        bio: s.bio,
        specialty: s.specialty,
        registrationType: s.registrationType,
      }))
    );

    const created = result.count;
    const skipped = rows.length - created - errors.length;

    apiLogger.info({ msg: "Import complete", importType: "speakers", source: "csv", eventId, userId: session.user.id, created, skipped, errorCount: errors.length });
    if (errors.length > 0) {
      apiLogger.warn({ msg: "Import errors", importType: "speakers", source: "csv", eventId, userId: session.user.id, errors: errors.slice(0, 50) });
    }

    return NextResponse.json({ created, skipped, errors });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error importing speakers" });
    return NextResponse.json({ error: "Failed to import speakers" }, { status: 500 });
  }
}
