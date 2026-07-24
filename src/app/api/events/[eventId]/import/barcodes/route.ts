import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
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
    const orgGuard = requireOrgId(session);
    if ("error" in orgGuard) return orgGuard.error;

    const denied = denyReviewer(session);
    if (denied) return denied;

    // Verify event access
    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: orgGuard.orgId },
      select: { id: true, requiresDtcmBarcode: true },
    });

    if (!event) {
      apiLogger.warn({ msg: "barcode-import:event-not-found", eventId, userId: session.user.id });
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    // DTCM barcodes are a Dubai (DET/DTCM) compliance artifact — only
    // importable for events flagged as Dubai. Mirrors the gated DTCM field
    // and the hidden "Import Barcodes" button so the model stays coherent.
    if (!event.requiresDtcmBarcode) {
      apiLogger.warn({ msg: "barcode-import:event-not-dtcm-flagged", eventId, userId: session.user.id });
      return NextResponse.json(
        { error: "DTCM barcodes only apply to Dubai events. Enable 'Requires DTCM barcode' in Settings → Registration first." },
        { status: 400 },
      );
    }

    const formData = await req.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      apiLogger.warn({ msg: "barcode-import:no-file", eventId, userId: session.user.id });
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    const text = await file.text();
    const { headers, rows, error: csvError } = parseCSV(text);

    if (csvError || rows.length === 0) {
      apiLogger.warn({ msg: "barcode-import:csv-empty", eventId, userId: session.user.id, csvError });
      return NextResponse.json({ error: csvError || "CSV is empty" }, { status: 400 });
    }

    // Find column indices
    const barcodeCol = findCol(headers, ["barcode", "barcodenumber", "barcode_number", "dtcm_barcode", "dtcmbarcode"]);
    const regIdCol = findCol(headers, ["registrationid", "registration_id", "regid", "id"]);
    const emailCol = findCol(headers, ["email"]);

    if (barcodeCol < 0) {
      apiLogger.warn({ msg: "barcode-import:missing-barcode-column", eventId, userId: session.user.id });
      return NextResponse.json({ error: "CSV must have a 'barcode' column" }, { status: 400 });
    }

    if (regIdCol < 0 && emailCol < 0) {
      apiLogger.warn({ msg: "barcode-import:missing-id-column", eventId, userId: session.user.id });
      return NextResponse.json({ error: "CSV must have a 'registrationId' or 'email' column" }, { status: 400 });
    }

    let imported = 0;
    let skipped = 0;
    const errors: string[] = [];

    // Every row runs inside its own try/catch (review M3): DTCM imports land
    // 1–2 days before a Dubai compliance deadline, and before this a single
    // throwing row (e.g. a P2002 unique-collision racing another import)
    // aborted the WHOLE request with a generic 500 and DISCARDED the report —
    // leaving a partially-applied import with no record of which rows landed.
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 2; // 1-indexed + header row
      try {
        const barcode = getField(row, barcodeCol)?.trim();
        const registrationId = regIdCol >= 0 ? getField(row, regIdCol)?.trim() : undefined;
        const email = emailCol >= 0 ? getField(row, emailCol)?.trim()?.toLowerCase() : undefined;

        if (!barcode) {
          skipped++;
          continue;
        }

        // Find registration by ID (preferred) or by email + event
        let registration: { id: string; dtcmBarcode?: string | null } | null = null;

        if (registrationId) {
          registration = await db.registration.findFirst({
            where: { id: registrationId, eventId },
            select: { id: true, dtcmBarcode: true },
          });
        }

        if (!registration && email) {
          // Deterministic match (review M4): a person can hold two
          // registrations on one email — prefer a non-cancelled one, newest
          // first, instead of whatever the planner returned that day.
          registration =
            (await db.registration.findFirst({
              where: { eventId, status: { not: "CANCELLED" }, attendee: { email } },
              orderBy: { createdAt: "desc" },
              select: { id: true, dtcmBarcode: true },
            })) ??
            (await db.registration.findFirst({
              where: { eventId, attendee: { email } },
              orderBy: { createdAt: "desc" },
              select: { id: true, dtcmBarcode: true },
            }));
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

        // Replacing a DIFFERENT existing barcode is allowed (re-imports fix
        // mistakes) but must be traceable (review L2) — log it, never silent.
        if (registration.dtcmBarcode && registration.dtcmBarcode !== barcode) {
          apiLogger.warn({
            msg: "barcode-import:overwriting-existing-barcode",
            eventId,
            registrationId: registration.id,
            rowNum,
            userId: session.user.id,
          }, "Row replaces a different existing DTCM barcode on this registration");
        }

        await db.registration.update({
          where: { id: registration.id },
          data: { dtcmBarcode: barcode },
        });

        imported++;
      } catch (rowErr) {
        // Isolate the failure to this row; the import report survives.
        const isUniqueCollision =
          rowErr instanceof Prisma.PrismaClientKnownRequestError && rowErr.code === "P2002";
        apiLogger.error({
          err: rowErr,
          msg: "barcode-import:row-failed",
          eventId,
          rowNum,
          userId: session.user.id,
        });
        errors.push(
          isUniqueCollision
            ? `Row ${rowNum}: Barcode already assigned to another registration (concurrent import)`
            : `Row ${rowNum}: Failed to apply this row — see server logs`,
        );
      }
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
