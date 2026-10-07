import type { Contact, Prisma, UserRole } from "@prisma/client";
import { z } from "zod";
import { apiLogger } from "@/lib/logger";

const emailSchema = z.string().email().max(255);

/**
 * The registration and speaker email changes also rewrite the linked User's
 * SIGN-IN email. For a registrant, submitter or reviewer account that is the
 * point (staff fix a typo). For a staff account it is a takeover: whoever
 * may edit a registration would repoint an admin's login to their own
 * mailbox and use forgot-password (Phase 6 review H1, Oct 7, 2026). So a
 * linked staff account is refused, and the write itself re-checks the role so
 * a promotion between the check and the commit cannot slip through. An
 * allow-list, so a role added later is protected until someone decides
 * otherwise.
 */
const CASCADABLE_ROLES: UserRole[] = ["REGISTRANT", "SUBMITTER", "REVIEWER"];

export const LINKED_STAFF_ACCOUNT = {
  error:
    "This person signs in with a staff account, so its email cannot be changed from here. The account holder changes it themselves.",
  code: "LINKED_STAFF_ACCOUNT",
} as const;

export function isProtectedLinkedAccount(role: string | null | undefined): boolean {
  return !(CASCADABLE_ROLES as string[]).includes(role ?? "");
}

export class LinkedStaffAccountError extends Error {
  constructor() {
    super("LINKED_STAFF_ACCOUNT");
  }
}

/** Rewrites a linked User's email unless it is a staff account; throws inside the transaction if it became one. */
export async function cascadeLinkedUserEmail(
  tx: Prisma.TransactionClient,
  userId: string,
  newEmail: string,
): Promise<void> {
  const res = await tx.user.updateMany({
    where: { id: userId, role: { in: CASCADABLE_ROLES } },
    data: { email: newEmail },
  });
  if (res.count !== 1) throw new LinkedStaffAccountError();
}

export function normalizeEmail(raw: unknown): string | null {
  const parsed = emailSchema.safeParse(typeof raw === "string" ? raw.trim().toLowerCase() : raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Scalar Contact fields that a merge may copy from the losing row into the
 * surviving row when the survivor's value is blank. Enrich-only — a survivor's
 * existing value always wins (same rule as contact-sync's omitBlankFields).
 * firstName/lastName are excluded: both rows carry required names and the
 * survivor's identity wins outright. tags/eventIds/notes have their own
 * union/append handling below.
 */
const MERGE_SCALAR_FIELDS = [
  "title",
  "role",
  "additionalEmail",
  "organization",
  "jobTitle",
  "bio",
  "specialty",
  "customSpecialty",
  "registrationType",
  "phone",
  "photo",
  "city",
  "state",
  "zipCode",
  "country",
  "associationName",
  "memberId",
  "studentId",
  "studentIdExpiry",
] as const;

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || value === "";
}

/**
 * Find the org's Contact at `email`, tolerating legacy mixed-case rows.
 * Exact match wins (when a case-variant duplicate pair exists — the known
 * un-backfilled H2 legacy — the canonical row is preferred deterministically);
 * otherwise fall back to a case-insensitive match so a pre-July-2026 row like
 * `John@Hospital.com` is still found when callers pass the normalized
 * lowercase form. Without the fallback the repoint silently no-ops ("none")
 * and the next sync mints a duplicate at the new address.
 */
async function findOrgContactByEmail(
  tx: Prisma.TransactionClient,
  organizationId: string,
  email: string,
): Promise<Contact | null> {
  const exact = await tx.contact.findFirst({ where: { organizationId, email } });
  if (exact) return exact;
  return tx.contact.findFirst({
    where: { organizationId, email: { equals: email, mode: "insensitive" } },
  });
}

/**
 * Re-point the org's Contact row from oldEmail to newEmail inside a
 * transaction. If no Contact at oldEmail exists, no-ops ("none").
 *
 * If a Contact at newEmail already exists in the org, the two rows are
 * MERGED into the existing row before the old row is deleted:
 *   - blank survivor scalars are filled from the old row (enrich-only),
 *   - `tags` and `eventIds` are unioned (tags drive cert auto-issue, email
 *     cohorts and the external people sync; eventIds feed the EU mirror's
 *     events_attended — neither may be silently dropped),
 *   - `notes` are appended with a provenance marker when both rows carry them,
 *   - `CrmContact.contactId` pointers are re-pointed to the survivor FIRST —
 *     the FK is `onDelete: SetNull`, and a DB cascade fires no application
 *     code, so without the explicit re-point the CRM's "this rep is also
 *     registered" link would silently vanish (accommodation-H4 class).
 *
 * Returns `"updated" | "merged" | "none"` for the audit log.
 */
export async function repointOrgContactEmail(
  tx: Prisma.TransactionClient,
  { organizationId, oldEmail, newEmail }: { organizationId: string; oldEmail: string; newEmail: string }
): Promise<"updated" | "merged" | "none"> {
  const old = await findOrgContactByEmail(tx, organizationId, oldEmail);
  if (!old) return "none";

  const collision = await findOrgContactByEmail(tx, organizationId, newEmail);

  // Degenerate guard: callers reject NO_CHANGE on normalized emails, but a
  // legacy mixed-case row can make old and collision resolve to the same row
  // (e.g. `John@X.com` found for both sides). Canonicalize in place.
  if (collision && collision.id !== old.id) {
    const fills: Record<string, unknown> = {};
    for (const field of MERGE_SCALAR_FIELDS) {
      if (isBlank(collision[field]) && !isBlank(old[field])) fills[field] = old[field];
    }

    const mergedTags = Array.from(new Set([...collision.tags, ...old.tags]));
    if (mergedTags.length !== collision.tags.length) fills.tags = mergedTags;
    const mergedEventIds = Array.from(new Set([...collision.eventIds, ...old.eventIds]));
    if (mergedEventIds.length !== collision.eventIds.length) fills.eventIds = mergedEventIds;

    if (!isBlank(old.notes)) {
      fills.notes = isBlank(collision.notes)
        ? old.notes
        : `${collision.notes}\n\n— Merged from a duplicate contact (${old.email}) —\n${old.notes}`;
    }

    if (Object.keys(fills).length > 0) {
      await tx.contact.update({ where: { id: collision.id }, data: fills });
    }

    const repointed = await tx.crmContact.updateMany({
      where: { contactId: old.id },
      data: { contactId: collision.id },
    });

    await tx.contact.delete({ where: { id: old.id } });

    apiLogger.info({
      msg: "contact-email-change:merged",
      organizationId,
      survivorContactId: collision.id,
      deletedContactId: old.id,
      fieldsFilled: Object.keys(fills),
      crmLinksRepointed: repointed.count,
    });
    return "merged";
  }

  await tx.contact.update({
    where: { id: old.id },
    data: { email: newEmail },
  });
  return "updated";
}
