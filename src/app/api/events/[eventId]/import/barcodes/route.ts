import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { parseCSV, getField } from "@/lib/csv-parser";

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

function findCol(headers: string[], names: string[]): number {
  for (const n of names) {
    const idx = headers.indexOf(n.toLowerCase().replace(/\s+/g, ""));
    if (idx >= 0) return idx;
  }
  return -1;
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    // Verify event access
    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: session.user.organizationId! },
      select: { id: true },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const formData = await req.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    const text = await file.text();
    const { headers, rows, error: csvError } = parseCSV(text);

    if (csvError || rows.length === 0) {
      return NextResponse.json({ error: csvError || "CSV is empty" }, { status: 400 });
    }

    // Find column indices
    const barcodeCol = findCol(headers, ["barcode", "barcodenumber", "barcode_number", "dtcm_barcode", "dtcmbarcode"]);
    const regIdCol = findCol(headers, ["registrationid", "registration_id", "regid", "id"]);
    const emailCol = findCol(headers, ["email"]);

    if (barcodeCol < 0) {
      return NextResponse.json({ error: "CSV must have a 'barcode' column" }, { status: 400 });
    }

    if (regIdCol < 0 && emailCol < 0) {
      return NextResponse.json({ error: "CSV must have a 'registrationId' or 'email' column" }, { status: 400 });
    }

    let imported = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 2; // 1-indexed + header row
      const barcode = getField(row, barcodeCol)?.trim();
      const registrationId = regIdCol >= 0 ? getField(row, regIdCol)?.trim() : undefined;
      const email = emailCol >= 0 ? getField(row, emailCol)?.trim()?.toLowerCase() : undefined;

      if (!barcode) {
        skipped++;
        continue;
      }

      // Find registration by ID (preferred) or by email + event
      let registration: { id: string } | null = null;

      if (registrationId) {
        registration = await db.registration.findFirst({
          where: { id: registrationId, eventId },
          select: { id: true },
        });
      }

      if (!registration && email) {
        registration = await db.registration.findFirst({
          where: {
            eventId,
            attendee: { email },
          },
          select: { id: true },
        });
      }

      if (!registration) {
        errors.push(`Row ${rowNum}: Registration not found${registrationId ? ` (ID: ${registrationId})` : email ? ` (email: ${email})` : ""}`);
        continue;
      }

      // Check for duplicate barcode
      const existing = await db.registration.findFirst({
        where: { dtcmBarcode: barcode, NOT: { id: registration.id } },
        select: { id: true },
      });

      if (existing) {
        errors.push(`Row ${rowNum}: Barcode "${barcode}" already assigned to another registration`);
        continue;
      }

      await db.registration.update({
        where: { id: registration.id },
        data: { dtcmBarcode: barcode },
      });

      imported++;
    }

    apiLogger.info({
      msg: "Barcode CSV import completed",
      eventId,
      imported,
      skipped,
      errors: errors.length,
    });

    return NextResponse.json({ imported, skipped, errors });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error importing barcodes" });
    return NextResponse.json({ error: "Import failed" }, { status: 500 });
  }
}
