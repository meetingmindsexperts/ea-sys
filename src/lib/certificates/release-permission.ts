/**
 * May this caller send certificates on this event right now? (Nov 11, 2026,
 * review of 631e95bd, H2.)
 *
 * Assigning a certificate and turning a template's survey switch on are
 * template setup (certificates.templates.manage, which an organisation API
 * key holds). When either would email people who already answered, that is
 * sending certificates, which is certificates.issue: the key the Issue tab
 * asks and that no API key holds. The service refuses the send-now with
 * SEND_NOW_NOT_PERMITTED unless this says yes.
 *
 * No principal (a door that cannot say who is calling) is a no: fail closed.
 */

import { loadEventFacts } from "@/lib/agent/event-facts-loader";
import { can, type Principal } from "@/lib/permissions/can";

export async function mayReleaseCertificates(
  principal: Principal | null | undefined,
  eventId: string,
  organizationId: string,
): Promise<boolean> {
  if (!principal || !can(principal, "certificates.issue")) return false;
  const facts = await loadEventFacts(eventId, organizationId);
  return facts !== null && can(principal, "certificates.issue", { event: facts });
}
