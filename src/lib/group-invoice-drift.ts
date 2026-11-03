/**
 * Group-invoice drift on member cancellation (review H4), out of
 * group-registration-service so the registration and payment services can
 * flag it without importing that service, which imports registration-service
 * back (the runtime cycle the dependency audit found, Nov 3, 2026). A leaf:
 * it imports no service.
 */
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { notifyEventAdmins } from "@/lib/notifications";

/**
 * A group's consolidated invoice freezes its totals at issue, but its line
 * items derive from live (non-cancelled) members — cancelling/deleting a
 * member makes the document internally inconsistent until finance acts
 * (review H4). This flags it: warn log + admin notification per affected
 * group. Fire-and-forget contract — NEVER throws (the cancellation already
 * committed); call with the ids BEFORE the rows are deleted.
 */
export async function flagGroupInvoiceDriftForCancelledMembers(
  eventId: string,
  registrationIds: string[],
): Promise<void> {
  try {
    if (registrationIds.length === 0) return;
    const members = await db.registration.findMany({
      where: { id: { in: registrationIds }, eventId, groupId: { not: null } },
      select: {
        groupId: true,
        attendee: { select: { firstName: true, lastName: true } },
        group: {
          select: {
            billingAccount: { select: { name: true } },
            invoices: { where: { status: { notIn: ["CANCELLED"] } }, select: { invoiceNumber: true }, take: 1 },
          },
        },
      },
    });
    const byGroup = new Map<string, { names: string[]; payer: string; invoiceNumber: string | null }>();
    for (const m of members) {
      if (!m.groupId) continue;
      const cur = byGroup.get(m.groupId) ?? {
        names: [],
        payer: m.group?.billingAccount.name ?? "the payer",
        invoiceNumber: m.group?.invoices[0]?.invoiceNumber ?? null,
      };
      cur.names.push(`${m.attendee.firstName} ${m.attendee.lastName}`.trim());
      byGroup.set(m.groupId, cur);
    }
    for (const [groupId, info] of byGroup) {
      apiLogger.warn(
        { groupId, eventId, cancelledMembers: info.names, invoiceNumber: info.invoiceNumber },
        "group-registration:member-cancelled-invoice-drift",
      );
      notifyEventAdmins(eventId, {
        type: "REGISTRATION",
        title: "⚠ Group invoice no longer matches its members",
        message: `${info.names.join(", ")} cancelled from a group registration billed to ${info.payer}${info.invoiceNumber ? ` (invoice ${info.invoiceNumber})` : ""}. The invoice total still includes them — issue a credit note or reissue the invoice.`,
        link: `/events/${eventId}/invoices`,
      }).catch((err) =>
        apiLogger.error({ err, groupId }, "group-registration:drift-notify-failed"),
      );
    }
  } catch (err) {
    apiLogger.error({ err, eventId }, "group-registration:drift-flag-failed");
  }
}
