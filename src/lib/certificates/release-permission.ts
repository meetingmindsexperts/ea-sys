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

import type { Principal } from "@/lib/permissions/can";
import { holdsOnEvent } from "@/lib/permissions/holds-on-event";

export function mayReleaseCertificates(
  principal: Principal | null | undefined,
  eventId: string,
  organizationId: string,
): Promise<boolean> {
  return holdsOnEvent(principal, "certificates.issue", eventId, organizationId);
}
