import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { auth } from "@/lib/auth";
import { requireOrgId } from "@/lib/require-org";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { recordImport } from "@/lib/audit-data-transfer";
import { denyReviewer } from "@/lib/auth-guards";
import { parseCSV, getField } from "@/lib/csv-parser";
import { runWithTenant } from "@/lib/tenant-context";
import { importDtcmCodes } from "@/lib/dtcm-pool";

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
    const orgGuard = requireOrgId(session, { route: "events/[eventId]/import/barcodes:POST" });
    if ("error" in orgGuard) return orgGuard.error;

    const denied = denyReviewer(session, { route: "events/[eventId]/import/barcodes:POST" });
    if (denied) return denied;

    return await runWithTenant(orgGuard.orgId, async () => {
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
    // DECLARED, never inferred. A file of assignments and a file of leftover
    // codes are indistinguishable to a header sniffer the moment somebody's
    // column is called `attendee_email` — and inferring "these are spares"
    // there would turn every intended assignment into an unclaimed code with
    // nothing said about it. Same rule the Freshsales importer settled on for
    // date order: a guess that is usually right is exactly the failure mode.
    const mode: "assign" | "spares" = formData.get("mode") === "spares" ? "spares" : "assign";

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

    // Only in assign mode. Without an owner column EVERY row falls through to
    // the spares branch below, so a mistyped header would silently convert a
    // whole file of assignments into unclaimed codes — and the people they were
    // meant for would arrive with none. In spares mode the operator has already
    // said the file is leftovers, so no owner column is expected.
    if (mode === "assign" && regIdCol < 0 && emailCol < 0) {
      apiLogger.warn({
        msg: "barcode-import:missing-id-column",
        eventId,
        userId: session.user.id,
        // Column names, not data — safe to log, and the first thing anyone
        // debugging "why was my file rejected?" wants to see.
        headers,
      });
      return NextResponse.json(
        {
          error:
            "This file has no 'registrationId' or 'email' column, so there is nobody to assign the codes to. " +
            `Columns found: ${headers.join(", ") || "(none)"}. ` +
            'If these are leftover codes for the desk to hand out, choose "Spare codes for the desk" and upload it again.',
          code: "MISSING_OWNER_COLUMN",
        },
        { status: 400 },
      );
    }

    let imported = 0;
    let skipped = 0;
    const errors: string[] = [];

    // Every row runs inside its own try/catch (review M3): DTCM imports land
    // 1–2 days before a Dubai compliance deadline, and before this a single
    // throwing row (e.g. a P2002 unique-collision racing another import)
    // aborted the WHOLE request with a generic 500 and DISCARDED the report —
    // leaving a partially-applied import with no record of which rows landed.
    /** Ownerless rows — spares for the pool (see the branch below). */
    const poolCodes: string[] = [];

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

        // A row with a code and NO owner at all is a SPARE — one of the
        // leftovers from the DTCM block that the desk hands to walk-ups on the
        // day. It goes to the pool instead of erroring.
        //
        // The distinction is deliberately "no owner value", not "no match": a
        // row naming an email that does not resolve is still an ERROR below.
        // A typo'd address must never quietly become a spare code, because the
        // person it was meant for would then arrive with none and nothing would
        // have said so.
        if (!registrationId && !email) {
          poolCodes.push(barcode);
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

        // Check for duplicate barcode — event-scoped (the pre-check no longer
        // probes the GLOBAL barcode namespace; a cross-org collision now
        // surfaces as the write's P2002, handled generically below).
        const existing = await db.registration.findFirst({
          where: { eventId, dtcmBarcode: barcode, NOT: { id: registration.id } },
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
          where: { id: registration.id, eventId },
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

    // Spares last, so a file that mixes assignments and leftovers applies the
    // assignments first — a code claimed by a named person is never also
    // offered to the desk as spare.
    const pool = poolCodes.length
      ? await importDtcmCodes({
          eventId,
          organizationId: orgGuard.orgId,
          codes: poolCodes,
          importedById: session.user.id,
        })
      : { imported: 0, duplicates: 0 };

    apiLogger.info({
      msg: "Barcode CSV import completed",
      eventId,
      mode,
      imported,
      skipped,
      errors: errors.length,
      pooled: pool.imported,
      poolDuplicates: pool.duplicates,
    });

    recordImport(req, {
      entityType: "RegistrationBarcode",
      eventId,
      organizationId: session.user.organizationId,
      userId: session.user.id,
      role: session.user.role,
      totalProcessed: imported + skipped + errors.length + poolCodes.length,
      updated: imported,
      created: pool.imported,
      skipped,
      errors: errors.length,
      format: "csv",
    });

    return NextResponse.json({
      imported,
      skipped,
      errors,
      pooled: pool.imported,
      poolDuplicates: pool.duplicates,
    });
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error importing barcodes" });
    return NextResponse.json({ error: "Import failed" }, { status: 500 });
  }
}
