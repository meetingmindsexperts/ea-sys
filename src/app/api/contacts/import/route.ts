import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { recordImport } from "@/lib/audit-data-transfer";
import { checkRateLimit } from "@/lib/security";
import { getOrgContext } from "@/lib/api-auth";
import { denyReviewer } from "@/lib/auth-guards";
import { parseCSV, getField, parseTags } from "@/lib/csv-parser";
import { parseAttendeeRole, parseTitle, type AttendeeRoleValue, type TitleValue } from "@/lib/schemas";

export async function POST(req: Request) {
  try {
    const ctx = await getOrgContext(req);

    if (!ctx) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Blocks REVIEWER/SUBMITTER/REGISTRANT/MEMBER (single source of truth);
    // API-key auth (role null) passes through as admin-equivalent.
    const denied = denyReviewer({ user: { role: ctx.role ?? undefined } });
    if (denied) return denied;

    // Tenancy pilot: ALS tenant scope (no-op while RLS_SET_LOCAL is off).
    return await runWithTenant(ctx.organizationId, async () => {

    const importRateLimit = checkRateLimit({
      key: `contacts-import:org:${ctx.organizationId}`,
      limit: 10,
      windowMs: 60 * 60 * 1000,
    });

    if (!importRateLimit.allowed) {
      apiLogger.warn({ msg: "contacts/import:rate-limited", retryAfterSeconds: importRateLimit.retryAfterSeconds });
      return NextResponse.json(
        { error: "Import limit reached. Maximum 10 imports per hour." },
        { status: 429, headers: { "Retry-After": String(importRateLimit.retryAfterSeconds) } }
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
      apiLogger.warn({ msg: "Contacts CSV parse error", userId: ctx.userId, error: parseError });
      return NextResponse.json({ error: parseError }, { status: 400 });
    }

    const idx = {
      title: headers.indexOf("title"),
      firstName: headers.indexOf("firstname"),
      lastName: headers.indexOf("lastname"),
      email: headers.indexOf("email"),
      organization: headers.indexOf("organization"),
      jobTitle: headers.indexOf("jobtitle"),
      specialty: headers.indexOf("specialty"),
      role: headers.indexOf("role"),
      bio: headers.indexOf("bio"),
      phone: headers.indexOf("phone"),
      tags: headers.indexOf("tags"),
      notes: headers.indexOf("notes"),
    };

    if (idx.firstName === -1 || idx.lastName === -1 || idx.email === -1) {
      apiLogger.warn({ msg: "Contacts CSV missing required columns", userId: ctx.userId, headers });
      return NextResponse.json(
        { error: "CSV must have firstName, lastName, and email columns" },
        { status: 400 }
      );
    }

    const errors: string[] = [];

    // Unrecognized enum cells are non-fatal (the fields are optional) but must

    // not be SILENT — a mis-typed column would otherwise null every row while

    // reporting a clean import. Counted, then warn-logged once below.

    let unrecognizedRole = 0;

    let unrecognizedTitle = 0;
    const contacts: {
      organizationId: string;
      email: string;
      title?: TitleValue | null;
      firstName: string;
      lastName: string;
      organization?: string;
      jobTitle?: string;
      specialty?: string;
      role?: AttendeeRoleValue | null;
      bio?: string;
      phone?: string;
      tags: string[];
      notes?: string;
    }[] = [];

    for (let i = 0; i < rows.length; i++) {
      const fields = rows[i];
      const email = getField(fields, idx.email)?.toLowerCase();
      const firstName = getField(fields, idx.firstName);
      const lastName = getField(fields, idx.lastName);

      if (!email || !firstName || !lastName) {
        errors.push(`Row ${i + 2}: missing required fields (firstName, lastName, email)`);
        continue;
      }

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        errors.push(`Row ${i + 2}: invalid email "${email}"`);
        continue;
      }

      const titleCell = getField(fields, idx.title);
      const title = parseTitle(titleCell);
      if (titleCell && !title) unrecognizedTitle++;
      const roleCell = getField(fields, idx.role);
      const role = parseAttendeeRole(roleCell);
      if (roleCell && !role) unrecognizedRole++;

      contacts.push({
        organizationId: ctx.organizationId,
        email,
        // Honorific — the Contact model has carried `title` all along; this
        // importer silently dropped it (same class as the missing `role`).
        title,
        firstName,
        lastName,
        organization: getField(fields, idx.organization),
        jobTitle: getField(fields, idx.jobTitle),
        specialty: getField(fields, idx.specialty),
        // Profession category — shared parser, same acceptance rules as the
        // registrations/speakers imports (was silently dropped here).
        role,
        bio: getField(fields, idx.bio),
        phone: getField(fields, idx.phone),
        tags: parseTags(getField(fields, idx.tags)),
        notes: getField(fields, idx.notes),
      });
    }

    if (contacts.length === 0) {
      return NextResponse.json({ created: 0, skipped: 0, errors });
    }

    // Get count before to calculate created vs skipped
    const countBefore = await db.contact.count({
      where: { organizationId: ctx.organizationId },
    });

    await db.contact.createMany({
      data: contacts,
      skipDuplicates: true,
    });

    const countAfter = await db.contact.count({
      where: { organizationId: ctx.organizationId },
    });

    const created = countAfter - countBefore;
    const skipped = contacts.length - created;

    if (unrecognizedRole > 0 || unrecognizedTitle > 0) {
      apiLogger.warn({ msg: "Import unrecognized enum cells", importType: "contacts", source: "csv", userId: ctx.userId, organizationId: ctx.organizationId, unrecognizedRole, unrecognizedTitle });
    }

    recordImport(req, {
      entityType: "Contact",
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      role: ctx.role,
      source: ctx.fromApiKey ? "api" : "rest",
      totalProcessed: contacts.length,
      created,
      skipped,
      errors: errors.length,
      format: "csv",
    });

    return NextResponse.json({ created, skipped, errors });
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error importing contacts" });
    return NextResponse.json({ error: "Failed to import contacts" }, { status: 500 });
  }
}
