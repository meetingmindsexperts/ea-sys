import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/security";
import { getOrgContext } from "@/lib/api-auth";
import { parseCSV, getField, parseTags } from "@/lib/csv-parser";

export async function POST(req: Request) {
  try {
    const ctx = await getOrgContext(req);

    if (!ctx) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (ctx.role === "REVIEWER" || ctx.role === "SUBMITTER") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const importRateLimit = checkRateLimit({
      key: `contacts-import:org:${ctx.organizationId}`,
      limit: 10,
      windowMs: 60 * 60 * 1000,
    });

    if (!importRateLimit.allowed) {
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
      firstName: headers.indexOf("firstname"),
      lastName: headers.indexOf("lastname"),
      email: headers.indexOf("email"),
      organization: headers.indexOf("organization"),
      jobTitle: headers.indexOf("jobtitle"),
      specialty: headers.indexOf("specialty"),
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
    const contacts: {
      organizationId: string;
      email: string;
      firstName: string;
      lastName: string;
      organization?: string;
      jobTitle?: string;
      specialty?: string;
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

      contacts.push({
        organizationId: ctx.organizationId,
        email,
        firstName,
        lastName,
        organization: getField(fields, idx.organization),
        jobTitle: getField(fields, idx.jobTitle),
        specialty: getField(fields, idx.specialty),
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

    return NextResponse.json({ created, skipped, errors });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error importing contacts" });
    return NextResponse.json({ error: "Failed to import contacts" }, { status: 500 });
  }
}
