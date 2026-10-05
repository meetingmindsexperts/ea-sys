import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { recordImport } from "@/lib/audit-data-transfer";
import { requirePermission } from "@/lib/permissions/require-permission";
import { checkRateLimit, getClientIp } from "@/lib/security";
import { ensureCompanionsForSpeakerEmails } from "@/lib/speaker-companion";
import { parseCSV, getField, parseTags } from "@/lib/csv-parser";
import { parseAttendeeRole, parseTitle } from "@/lib/schemas";
import { syncManyToContacts } from "@/lib/contact-sync";
import { refreshEventStats } from "@/lib/event-stats";
import { updateSpeaker } from "@/services/speaker-service";
import { buildImportPatch, updatedRowMessage } from "@/lib/import-upsert";

const SPEAKER_STATUS_VALUES = new Set(["INVITED", "CONFIRMED", "DECLINED", "CANCELLED"]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// The fields a re-import may update on an existing speaker, with the labels
// the result shows ("Row 7: x@y.com updated (job title, bio)").
const SPEAKER_UPDATE_LABELS = {
  firstName: "first name",
  lastName: "last name",
  title: "title",
  role: "role",
  organization: "organisation",
  jobTitle: "job title",
  phone: "phone",
  bio: "bio",
  city: "city",
  state: "state",
  zipCode: "zip code",
  country: "country",
  specialty: "specialty",
  registrationType: "registration type",
  website: "website",
  additionalEmail: "additional email",
  status: "status",
} as const;
type SpeakerUpdateKey = keyof typeof SPEAKER_UPDATE_LABELS;

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session, { route: "events/[eventId]/import/speakers:POST" });
    if ("error" in orgGuard) return orgGuard.error;

    const gate = requirePermission(session, "speakers.import", { route: "events/[eventId]/import/speakers:POST", eventId });
    if (!gate.ok) return gate.response;

    // Tenancy sweep: ALS tenant scope (no-op while RLS_SET_LOCAL is off).
    const orgId = orgGuard.orgId;
    return await runWithTenant(orgId, async () => {
    const rateLimit = checkRateLimit({
      key: `import-speakers:org:${session.user.organizationId}`,
      limit: 10,
      windowMs: 60 * 60 * 1000,
    });
    if (!rateLimit.allowed) {
      apiLogger.warn({ msg: "events/import-speakers:rate-limited", retryAfterSeconds: rateLimit.retryAfterSeconds });
      return NextResponse.json(
        { error: "Import limit reached. Maximum 10 imports per hour." },
        { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } }
      );
    }

    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    // Update-or-create (Oct 2, 2026): the dialog sends "true" by default; any
    // other caller keeps the old skip-existing behaviour unless it opts in.
    const updateExisting = formData.get("updateExisting") === "true";
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
      role: headers.indexOf("role"),
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
      where: gate.eventWhere,
      select: { id: true },
    });
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    // Existing speakers by email: skipped, or updated when updateExisting.
    const existingSpeakers = await db.speaker.findMany({
      where: { eventId },
      select: {
        id: true, email: true, firstName: true, lastName: true, title: true, role: true,
        organization: true, jobTitle: true, phone: true, bio: true, city: true, state: true,
        zipCode: true, country: true, specialty: true, registrationType: true, website: true,
        additionalEmail: true, status: true, tags: true,
      },
    });
    const existingByEmail = new Map(existingSpeakers.map((sp) => [sp.email.toLowerCase(), sp]));

    apiLogger.info({ msg: "Import started", importType: "speakers", source: "csv", eventId, userId: session.user.id, rowCount: rows.length });

    const errors: string[] = [];
    // Which rows were skipped and why (Oct 2, 2026): the result used to give
    // only a count, so an organiser could not tell which people were left out.
    const skippedRows: string[] = [];
    const firstRowByEmail = new Map<string, number>();

    // Unrecognized enum cells are non-fatal (the fields are optional) but must

    // not be SILENT — a mis-typed column would otherwise null every row while

    // reporting a clean import. Counted, then warn-logged once below.

    let unrecognizedRole = 0;

    let unrecognizedTitle = 0;
    const speakers: Prisma.SpeakerCreateManyInput[] = [];
    const pendingUpdates: Array<{
      rowNum: number;
      email: string;
      existing: (typeof existingSpeakers)[number];
      incoming: Partial<Record<SpeakerUpdateKey, string>> & { tags: string[] };
    }> = [];

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

      const earlierRow = firstRowByEmail.get(email);
      if (earlierRow !== undefined) {
        skippedRows.push(`Row ${rowNum}: ${email} appears earlier in this file (row ${earlierRow})`);
        continue;
      }
      const titleCell = getField(fields, idx.title);
      const title = parseTitle(titleCell);
      if (titleCell && !title) unrecognizedTitle++;
      const roleCell = getField(fields, idx.role);
      const role = parseAttendeeRole(roleCell);
      if (roleCell && !role) unrecognizedRole++;
      const statusRaw = getField(fields, idx.status)?.toUpperCase();
      const statusCell = statusRaw && SPEAKER_STATUS_VALUES.has(statusRaw) ? statusRaw : undefined;

      // The row's values, shared by the create and the update paths. Empty
      // cells are undefined, so an update never clears a field.
      const incoming = {
        firstName,
        lastName,
        title: title ?? undefined,
        role: role ?? undefined,
        organization: getField(fields, idx.organization),
        jobTitle: getField(fields, idx.jobTitle),
        phone: getField(fields, idx.phone),
        bio: getField(fields, idx.bio),
        city: getField(fields, idx.city),
        state: getField(fields, idx.state),
        zipCode: getField(fields, idx.zipCode),
        country: getField(fields, idx.country),
        specialty: getField(fields, idx.specialty),
        registrationType: getField(fields, idx.registrationType),
        website: getField(fields, idx.website),
        additionalEmail: getField(fields, idx.additionalEmail)?.toLowerCase(),
        status: statusCell,
        tags: parseTags(getField(fields, idx.tags)),
      };

      firstRowByEmail.set(email, rowNum); // Later rows with this email are skipped

      const existing = existingByEmail.get(email);
      if (existing) {
        if (!updateExisting) {
          skippedRows.push(`Row ${rowNum}: ${email} is already a speaker on this event`);
          continue;
        }
        pendingUpdates.push({ rowNum, email, existing, incoming });
        continue;
      }

      speakers.push({
        eventId,
        organizationId: orgGuard.orgId, // multi-tenancy: Speaker sweep
        email,
        firstName,
        lastName,
        title,
        organization: incoming.organization || null,
        jobTitle: incoming.jobTitle || null,
        phone: incoming.phone || null,
        bio: incoming.bio || null,
        city: incoming.city || null,
        state: incoming.state || null,
        zipCode: incoming.zipCode || null,
        country: incoming.country || null,
        specialty: incoming.specialty || null,
        // Profession category (Physician, Allied Health, …) — same shared
        // parser + acceptance rules as the registrations/contacts imports.
        role,
        registrationType: incoming.registrationType || null,
        tags: incoming.tags,
        website: incoming.website || null,
        additionalEmail: getField(fields, idx.additionalEmail) || null,
        status: (statusCell ?? "INVITED") as "INVITED" | "CONFIRMED" | "DECLINED" | "CANCELLED",
      });
    }

    // Existing speakers named in the file: apply only the filled cells that
    // differ, through the same service a manual edit uses (contact sync, the
    // linked registration, tag mirroring, decline cascade and audit included).
    let updated = 0;
    let unchanged = 0;
    const updatedRows: string[] = [];
    for (const u of pendingUpdates) {
      const { patch, changed } = buildImportPatch<SpeakerUpdateKey>(u.existing, u.incoming, SPEAKER_UPDATE_LABELS);
      if (changed.length === 0) {
        unchanged++;
        continue;
      }
      const result = await updateSpeaker({
        speakerId: u.existing.id,
        eventId,
        organizationId: orgGuard.orgId,
        fields: patch as Parameters<typeof updateSpeaker>[0]["fields"],
        source: "rest",
        actorUserId: session.user.id,
        requestIp: getClientIp(req),
      });
      if (!result.ok) {
        apiLogger.warn({ msg: "Import update failed", importType: "speakers", eventId, rowNum: u.rowNum, code: result.code });
        errors.push(`Row ${u.rowNum}: could not update ${u.email} (${result.message})`);
        continue;
      }
      updated++;
      updatedRows.push(updatedRowMessage(u.rowNum, u.email, changed));
    }
    if (updatedRows.length > 0) {
      apiLogger.info({ msg: "Import updated rows", importType: "speakers", source: "csv", eventId, updatedRows: updatedRows.slice(0, 50) });
    }

    if (speakers.length === 0) {
      const skipped = rows.length - updated - unchanged - errors.length;
      apiLogger.info({ msg: "Import complete", importType: "speakers", source: "csv", eventId, userId: session.user.id, created: 0, updated, unchanged, skipped, errorCount: errors.length });
      if (errors.length > 0) {
        apiLogger.warn({ msg: "Import errors", importType: "speakers", source: "csv", eventId, userId: session.user.id, errors: errors.slice(0, 50) });
      }
      if (skippedRows.length > 0) {
        apiLogger.info({ msg: "Import skipped rows", importType: "speakers", source: "csv", eventId, skippedRows: skippedRows.slice(0, 50) });
      }
      if (updated > 0 || unchanged > 0) {
        recordImport(req, {
          entityType: "Speaker",
          eventId,
          organizationId: orgGuard.orgId,
          userId: session.user.id,
          role: session.user.role,
          totalProcessed: rows.length,
          created: 0,
          updated,
          skipped,
          errors: errors.length,
          format: "csv",
        });
      }
      return NextResponse.json({ created: 0, updated, unchanged, skipped, errors, skippedRows, updatedRows });
    }

    const result = await db.speaker.createMany({
      data: speakers,
      skipDuplicates: true,
    });

    // Audit trail (fire-and-forget) — bulk speaker import via CSV.
    db.auditLog
      .create({
        data: {
          eventId,
          userId: session.user.id,
          action: "CREATE",
          entityType: "Speaker",
          entityId: `bulk:${result.count}`,
          changes: {
            bulk: true,
            source: "csv-import",
            created: result.count,
            updated,
            skipped: rows.length - result.count - updated - unchanged - errors.length,
            errorCount: errors.length,
            ip: getClientIp(req),
          },
          ipAddress: getClientIp(req),
        },
      })
      .catch((err) => apiLogger.error({ err, msg: "Failed to write speaker CSV-import audit log" }));

    // Sync imported speakers to org contact store (fire-and-forget)
    syncManyToContacts(
      speakers.map((s) => ({
        organizationId: orgGuard.orgId,
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
        role: s.role,
        registrationType: s.registrationType,
      }))
    );

    // Refresh denormalized event stats (fire-and-forget)
    refreshEventStats(eventId);

    // Ensure each imported speaker gets a companion registration (badge /
    // barcode / DTCM / check-in / survey). Awaited; per-item failure-isolated.
    await ensureCompanionsForSpeakerEmails(eventId, speakers.map((s) => s.email));

    const created = result.count;
    const skipped = rows.length - created - updated - unchanged - errors.length;

    apiLogger.info({ msg: "Import complete", importType: "speakers", source: "csv", eventId, userId: session.user.id, created, updated, unchanged, skipped, errorCount: errors.length });
    if (errors.length > 0) {
      apiLogger.warn({ msg: "Import errors", importType: "speakers", source: "csv", eventId, userId: session.user.id, errors: errors.slice(0, 50) });
    }

    if (unrecognizedRole > 0 || unrecognizedTitle > 0) {
      apiLogger.warn({ msg: "Import unrecognized enum cells", importType: "speakers", source: "csv", eventId, userId: session.user.id, unrecognizedRole, unrecognizedTitle });
    }

    recordImport(req, {
      entityType: "Speaker",
      eventId,
      organizationId: orgGuard.orgId,
      userId: session.user.id,
      role: session.user.role,
      totalProcessed: rows.length,
      created,
      updated,
      skipped,
      errors: errors.length,
      format: "csv",
    });

    if (skippedRows.length > 0) {
      apiLogger.info({ msg: "Import skipped rows", importType: "speakers", source: "csv", eventId, skippedRows: skippedRows.slice(0, 50) });
    }

    return NextResponse.json({ created, updated, unchanged, skipped, errors, skippedRows, updatedRows });
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error importing speakers" });
    return NextResponse.json({ error: "Failed to import speakers" }, { status: 500 });
  }
}
