import type { Prisma } from "@prisma/client";
import { z } from "zod";

const emailSchema = z.string().email().max(255);

export function normalizeEmail(raw: unknown): string | null {
  const parsed = emailSchema.safeParse(typeof raw === "string" ? raw.trim().toLowerCase() : raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Re-point the org's Contact row from oldEmail to newEmail inside a
 * transaction. If a Contact at newEmail already exists in the org, the
 * old Contact is deleted (its canonical identity has moved to the
 * existing row — callers should treat that as a silent merge). If no
 * Contact at oldEmail exists, no-ops.
 *
 * Returns `"updated" | "merged" | "none"` for the audit log.
 */
export async function repointOrgContactEmail(
  tx: Prisma.TransactionClient,
  { organizationId, oldEmail, newEmail }: { organizationId: string; oldEmail: string; newEmail: string }
): Promise<"updated" | "merged" | "none"> {
  const old = await tx.contact.findFirst({
    where: { organizationId, email: oldEmail },
    select: { id: true },
  });
  if (!old) return "none";

  const collision = await tx.contact.findFirst({
    where: { organizationId, email: newEmail },
    select: { id: true },
  });

  if (collision) {
    await tx.contact.delete({ where: { id: old.id } });
    return "merged";
  }

  await tx.contact.update({
    where: { id: old.id },
    data: { email: newEmail },
  });
  return "updated";
}
