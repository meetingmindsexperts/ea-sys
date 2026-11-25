import { db } from "@/lib/db";
import { can, principalFromUser } from "@/lib/permissions/can";
import { readUserGrants } from "@/lib/permissions/permission-set-service";
import type { PermissionKey } from "@/lib/permissions/catalogue";

/**
 * May this person be told about an email in the CRM inbox? (review of 62a2ee7a0,
 * Nov 25, 2026.) Owning a record says nothing about it: a contact created by
 * someone takes them as owner without any check, a person keeps their records
 * when deactivated, and the inbox is its own key, which a custom role may leave
 * out on purpose. The notification names the sender, the account and the subject
 * and opens the conversation, so it goes only to someone who could open both:
 *
 *   - a member of this organisation, not deactivated;
 *   - holding `crm.read` (the bell's own feed) and `crm.inbox.read` (the thread),
 *     from the base role or a custom role.
 *
 * Answers why not, or null when the person may be told.
 */
export type InboxNoticeRefusal = "not-in-organisation" | "deactivated" | "no-inbox-access";

const NEEDED: readonly PermissionKey[] = ["crm.read", "crm.inbox.read"];

export async function inboxNoticeRefusal(organizationId: string, userId: string): Promise<InboxNoticeRefusal | null> {
  const user = await db.user.findFirst({
    where: { id: userId, organizationId },
    select: { id: true, role: true, deactivatedAt: true },
  });
  if (!user) return "not-in-organisation";
  if (user.deactivatedAt) return "deactivated";

  const principal = principalFromUser({ id: user.id, role: user.role, organizationId });
  const fromBaseRole = NEEDED.filter((key) => !can(principal, key));
  if (fromBaseRole.length === 0) return null;

  const grants = await readUserGrants(organizationId, user.id);
  const held = new Set(grants.map((g) => g.permission));
  return fromBaseRole.every((key) => held.has(key)) ? null : "no-inbox-access";
}
