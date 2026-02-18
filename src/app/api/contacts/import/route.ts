import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { denyReviewer } from "@/lib/auth-guards";
import { apiLogger } from "@/lib/logger";

// Parse a single CSV line handling quoted fields
function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      fields.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  fields.push(current.trim());
  return fields;
}

export async function POST(req: Request) {
  try {
    const session = await auth();

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const formData = await req.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    const text = await file.text();
    const lines = text.split(/\r?\n/).filter((l) => l.trim());

    if (lines.length < 2) {
      return NextResponse.json({ error: "CSV must have a header row and at least one data row" }, { status: 400 });
    }

    const headers = parseCSVLine(lines[0]).map((h) => h.toLowerCase().replace(/\s+/g, ""));

    const idx = {
      firstName: headers.indexOf("firstname"),
      lastName: headers.indexOf("lastname"),
      email: headers.indexOf("email"),
      company: headers.indexOf("company"),
      jobTitle: headers.indexOf("jobtitle"),
      phone: headers.indexOf("phone"),
      tags: headers.indexOf("tags"),
      notes: headers.indexOf("notes"),
    };

    if (idx.firstName === -1 || idx.lastName === -1 || idx.email === -1) {
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
      company?: string;
      jobTitle?: string;
      phone?: string;
      tags: string[];
      notes?: string;
    }[] = [];

    for (let i = 1; i < lines.length; i++) {
      const fields = parseCSVLine(lines[i]);
      const email = fields[idx.email]?.toLowerCase().trim();
      const firstName = fields[idx.firstName]?.trim();
      const lastName = fields[idx.lastName]?.trim();

      if (!email || !firstName || !lastName) {
        errors.push(`Row ${i + 1}: missing required fields (firstName, lastName, email)`);
        continue;
      }

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        errors.push(`Row ${i + 1}: invalid email "${email}"`);
        continue;
      }

      const rawTags = idx.tags >= 0 ? fields[idx.tags]?.trim() : "";
      const tags = rawTags
        ? rawTags.split(",").map((t) => t.trim()).filter(Boolean)
        : [];

      contacts.push({
        organizationId: session.user.organizationId!,
        email,
        firstName,
        lastName,
        company: idx.company >= 0 ? fields[idx.company]?.trim() || undefined : undefined,
        jobTitle: idx.jobTitle >= 0 ? fields[idx.jobTitle]?.trim() || undefined : undefined,
        phone: idx.phone >= 0 ? fields[idx.phone]?.trim() || undefined : undefined,
        tags,
        notes: idx.notes >= 0 ? fields[idx.notes]?.trim() || undefined : undefined,
      });
    }

    if (contacts.length === 0) {
      return NextResponse.json({ created: 0, skipped: 0, errors });
    }

    // Get count before to calculate created vs skipped
    const countBefore = await db.contact.count({
      where: { organizationId: session.user.organizationId! },
    });

    await db.contact.createMany({
      data: contacts,
      skipDuplicates: true,
    });

    const countAfter = await db.contact.count({
      where: { organizationId: session.user.organizationId! },
    });

    const created = countAfter - countBefore;
    const skipped = contacts.length - created;

    return NextResponse.json({ created, skipped, errors });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error importing contacts" });
    return NextResponse.json({ error: "Failed to import contacts" }, { status: 500 });
  }
}
