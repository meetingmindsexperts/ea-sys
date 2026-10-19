/**
 * Give an in-person registration its entry barcode when it has none (Oct 19,
 * 2026). "Import from Contacts" never minted one, so such people could not be
 * scanned at check-in and their badge printed without a barcode; every place
 * a registration is picked up again (a speaker linked to it, a speaker
 * imported from it, the person completing their form) calls this so the gap
 * closes wherever the person turns up next. The backfill script
 * (scripts/backfill-registration-qrcodes.ts) fixes the rest.
 *
 * Guarded on `qrCode: null`: an existing barcode is never replaced, and two
 * callers racing mint at most one. A virtual attendee gets none (nothing to
 * scan, the same rule as `needsQrCode`). Server-only.
 */
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { needsQrCode } from "@/lib/registration-seat";
import { generateBarcode } from "@/lib/utils";

type RegistrationWriter = Pick<Prisma.TransactionClient, "registration">;

/**
 * Mints the barcode when needed. Returns the new code, or null when the
 * registration already had one, is virtual, or one was set meanwhile.
 */
export async function ensureEntryBarcode(
  reg: { id: string; qrCode: string | null; attendanceMode: "IN_PERSON" | "VIRTUAL" },
  context: string,
  client: RegistrationWriter = db,
): Promise<string | null> {
  if (!needsQrCode(reg.attendanceMode, reg.qrCode)) return null;
  const qrCode = generateBarcode();
  const res = await client.registration.updateMany({ where: { id: reg.id, qrCode: null }, data: { qrCode } });
  if (res.count === 0) return null;
  apiLogger.info({ msg: "entry-barcode:minted", registrationId: reg.id, context });
  return qrCode;
}
