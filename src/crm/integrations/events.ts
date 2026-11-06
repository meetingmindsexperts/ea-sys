/**
 * THE CRM'S EVENTS PORT (Nov 6, 2026; CRM product review P1-8).
 *
 * A deal is linked to an event (required: owner decision, kept on Nov 6). The
 * CRM's own direct questions about events go through here, never db.event:
 * does an event belong to this organisation, the names to pick from or group
 * by, and the event's email branding and tokens. The default answers from
 * EA-SYS's Event table.
 *
 * WHAT IS NOT BEHIND IT, ON PURPOSE: the `deal.event` relation that deal,
 * quote and email queries select through the CrmDeal → Event foreign key. That
 * is a schema relation, one query, and splitting it into a second round trip
 * per read would cost every deal page for a boundary no second implementation
 * uses yet. If the CRM is ever deployed apart, that FK becomes a plain event
 * id and those selects move here.
 */
import { db } from "@/lib/db";

/** The event columns the {{event…}} tokens read. */
export const EVENT_TOKEN_FIELDS = {
  startDate: true,
  endDate: true,
  timezone: true,
  venue: true,
  city: true,
  country: true,
} as const;

/** Everything an event contributes to a CRM email: branding and tokens. */
export const EVENT_EMAIL_FIELDS = {
  name: true,
  emailHeaderImage: true,
  emailFooterImage: true,
  emailFooterHtml: true,
  emailFromAddress: true,
  emailFromName: true,
  emailCcAddresses: true,
  ...EVENT_TOKEN_FIELDS,
} as const;

export interface CrmEventRef {
  id: string;
  name: string;
}

export interface CrmEventEmailContext {
  id: string;
  name: string;
  emailHeaderImage: string | null;
  emailFooterImage: string | null;
  emailFooterHtml: string | null;
  emailFromAddress: string | null;
  emailFromName: string | null;
  emailCcAddresses: string[];
  startDate: Date;
  endDate: Date;
  timezone: string | null;
  venue: string | null;
  city: string | null;
  country: string | null;
}

export interface CrmEventsProvider {
  /** True when the event exists in this organisation. */
  belongsTo(organizationId: string, eventId: string): Promise<boolean>;
  /** One event's id and name in this organisation, or null. */
  find(organizationId: string, eventId: string): Promise<CrmEventRef | null>;
  /** Every event's id and name (for name lookups: imports, report grouping). */
  listAll(organizationId: string): Promise<CrmEventRef[]>;
  /** The events a deal can be linked to: not draft, not cancelled, newest first. */
  listLinkable(organizationId: string): Promise<CrmEventRef[]>;
  /** The event's email branding and token values, or null. */
  emailContext(organizationId: string, eventId: string): Promise<CrmEventEmailContext | null>;
}

/** EA-SYS's Event table, behind the CRM's port. Every read is organisation-bound. */
export const crmEvents: CrmEventsProvider = {
  async belongsTo(organizationId, eventId) {
    return !!(await db.event.findFirst({ where: { id: eventId, organizationId }, select: { id: true } }));
  },
  find: (organizationId, eventId) => db.event.findFirst({ where: { id: eventId, organizationId }, select: { id: true, name: true } }),
  listAll: (organizationId) => db.event.findMany({ where: { organizationId }, select: { id: true, name: true } }),
  listLinkable: (organizationId) =>
    db.event.findMany({
      where: { organizationId, status: { notIn: ["DRAFT", "CANCELLED"] } },
      select: { id: true, name: true },
      orderBy: { startDate: "desc" },
      take: 1000,
    }),
  emailContext: (organizationId, eventId) =>
    db.event.findFirst({ where: { id: eventId, organizationId }, select: { id: true, ...EVENT_EMAIL_FIELDS } }),
};
