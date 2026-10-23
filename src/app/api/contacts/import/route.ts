import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { recordImport } from "@/lib/audit-data-transfer";
import { checkRateLimit } from "@/lib/security";
import { getOrgContext } from "@/lib/api-auth";
import { auth } from "@/lib/auth";
import { principalFromCaller, requirePermission } from "@/lib/permissions/require-permission";
import { parseCSV, getField, parseTags } from "@/lib/csv-parser";
import { ATTENDEE_ROLE_ORDER, formatAttendeeRole, parseAttendeeRole, parseTitle, type AttendeeRoleValue, type TitleValue } from "@/lib/schemas";
import { IMPORT_MAX_LENGTH, IMPORT_REQUIRED_MAX, IMPORT_TEXT_COLUMNS, parseImportDate, type ImportCappedColumn } from "@/lib/contact-export";
import { unescapeCsvCell } from "@/lib/csv-escape";

export async function POST(req: Request) {
  try {
    const ctx = await getOrgContext(req);

    if (!ctx) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Blocks REVIEWER/SUBMITTER/REGISTRANT/MEMBER (single source of truth);
    // API-key auth (role null) passes through as admin-equivalent.
    const gate = requirePermission(principalFromCaller(await auth(), ctx), "contacts.import", { route: "contacts/import:POST" });
    if (!gate.ok) return gate.response;

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
      apiLogger.warn({ msg: "contacts/import:no-file", organizationId: ctx.organizationId, userId: ctx.userId });
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
      studentIdExpiry: headers.indexOf("studentidexpiry"),
    };
    // The plain text columns the importer used to drop (Oct 23, 2026): city,
    // country and the rest. Same names as the export writes, so an exported
    // file comes back in whole.
    const textIdx = IMPORT_TEXT_COLUMNS.map((col) => [col, headers.indexOf(col.toLowerCase())] as const);

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

    let unreadableExpiry = 0;

    let invalidAdditionalEmail = 0;

    let tooLong = 0;
    const contacts: ({
      organizationId: string;
      email: string;
      title?: TitleValue | null;
      firstName: string;
      lastName: string;
      role?: AttendeeRoleValue | null;
      tags: string[];
      studentIdExpiry?: Date | null;
    } & Partial<Record<ImportCappedColumn, string>>)[] = [];

    for (let i = 0; i < rows.length; i++) {
      const fields = rows[i];
      // Every cell passes through the reverse of the export's formula guard,
      // so an exported file imports back as it was (`'-A123` -> `-A123`).
      const cell = (at: number) => unescapeCsvCell(getField(fields, at));
      const email = cell(idx.email)?.toLowerCase();
      const firstName = cell(idx.firstName);
      const lastName = cell(idx.lastName);

      if (!email || !firstName || !lastName) {
        errors.push(`Row ${i + 2}: missing required fields (firstName, lastName, email)`);
        continue;
      }

      if (firstName.length > IMPORT_REQUIRED_MAX.firstName || lastName.length > IMPORT_REQUIRED_MAX.lastName || email.length > IMPORT_REQUIRED_MAX.email) {
        errors.push(`Row ${i + 2}: name over 100 characters or email over 255`);
        continue;
      }

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        errors.push(`Row ${i + 2}: invalid email "${email}"`);
        continue;
      }

      const titleCell = cell(idx.title);
      const title = parseTitle(titleCell);
      if (titleCell && !title) unrecognizedTitle++;
      const roleCell = cell(idx.role);
      const role = parseAttendeeRole(roleCell);
      if (roleCell && !role) unrecognizedRole++;

      const expiryCell = cell(idx.studentIdExpiry);
      const studentIdExpiry = parseImportDate(expiryCell);
      if (expiryCell && !studentIdExpiry) unreadableExpiry++;

      const text: Partial<Record<ImportCappedColumn, string>> = {
        organization: cell(idx.organization),
        jobTitle: cell(idx.jobTitle),
        specialty: cell(idx.specialty),
        bio: cell(idx.bio),
        phone: cell(idx.phone),
        notes: cell(idx.notes),
      };
      for (const [col, at] of textIdx) text[col] = cell(at);
      // Over the form's cap: left empty and counted, never stored or cut.
      for (const col of Object.keys(text) as ImportCappedColumn[]) {
        const value = text[col];
        if (value && value.length <= IMPORT_MAX_LENGTH[col]) continue;
        if (value) tooLong++;
        delete text[col];
      }
      // A malformed second address is dropped, not saved: it would be mailed.
      if (text.additionalEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text.additionalEmail)) {
        invalidAdditionalEmail++;
        delete text.additionalEmail;
      }
      if (text.additionalEmail) text.additionalEmail = text.additionalEmail.toLowerCase();

      contacts.push({
        ...text,
        studentIdExpiry,
        organizationId: ctx.organizationId,
        email,
        // Honorific — the Contact model has carried `title` all along; this
        // importer silently dropped it (same class as the missing `role`).
        title,
        firstName,
        lastName,
        // Profession category — shared parser, same acceptance rules as the
        // registrations/speakers imports (was silently dropped here).
        role,
        tags: parseTags(cell(idx.tags)),
      });
    }

    if (contacts.length === 0) {
      return NextResponse.json({ created: 0, skipped: 0, errors, warnings: [] });
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

    // `errors` are rows NOT imported; `warnings` are rows imported with a value
    // left blank (Oct 23, 2026), so the page can say each plainly. Before this
    // an unrecognised role or title vanished with only a server log line.
    const warnings: string[] = [];
    if (unrecognizedRole > 0 || unrecognizedTitle > 0) {
      apiLogger.warn({ msg: "Import unrecognized enum cells", importType: "contacts", source: "csv", userId: ctx.userId, organizationId: ctx.organizationId, unrecognizedRole, unrecognizedTitle });
      if (unrecognizedRole > 0) warnings.push(`${unrecognizedRole} role value(s) were not recognised and were left blank. Use one of: ${ATTENDEE_ROLE_ORDER.map((r) => formatAttendeeRole(r)).join(", ")}.`);
      if (unrecognizedTitle > 0) warnings.push(`${unrecognizedTitle} title value(s) were not recognised and were left blank. Use one of: Dr, Prof, Mr, Mrs, Ms.`);
    }
    if (unreadableExpiry > 0 || invalidAdditionalEmail > 0 || tooLong > 0) {
      apiLogger.warn({ msg: "contacts/import:cells-dropped", userId: ctx.userId, organizationId: ctx.organizationId, unreadableExpiry, invalidAdditionalEmail, tooLong });
      if (tooLong > 0) warnings.push(`${tooLong} value(s) were longer than the contact form allows and were left blank.`);
      if (unreadableExpiry > 0) warnings.push(`${unreadableExpiry} student ID expiry date(s) were not in YYYY-MM-DD format (for example 2027-06-30) and were left blank.`);
      if (invalidAdditionalEmail > 0) warnings.push(`${invalidAdditionalEmail} additional email address(es) were not valid and were left blank.`);
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

    return NextResponse.json({ created, skipped, errors, warnings });
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error importing contacts" });
    return NextResponse.json({ error: "Failed to import contacts" }, { status: 500 });
  }
}
