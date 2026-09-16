/**
 * Shared render/recipient helpers for the certificate pipeline — extracted
 * from issue-worker.ts so BOTH the worker and the on-demand delivery service
 * (deliver.ts) can import them WITHOUT a circular dependency (the worker now
 * calls deliver.reRenderAndResendCert for bulk reissue, and deliver needs
 * these helpers — so they live here, imported by both).
 *
 * No behavior change from the original worker definitions.
 */

import { Prisma, type CertificateType } from "@prisma/client";
import { db } from "@/lib/db";
import { formatPersonName } from "@/lib/utils";
import type { CertificateData, AccreditationEntry } from "./types";

/**
 * Did a P2002 fire on the GLOBAL `IssuedCertificate.serial` unique index
 * (cross-event serial collision) rather than the per-template recipient
 * uniqueness? `serial` is unique across ALL events while the serial prefix
 * derives from the non-unique `Event.code`, so two same-code events can mint
 * the same serial. The two catch blocks that recover from P2002 assume the
 * recipient index; without this discriminator they misdiagnose a serial
 * collision as a recipient dup — burning a serial per retry and returning a
 * flatly wrong ALREADY_ISSUED. (The durable fix — @@unique([eventId, serial])
 * — is a deferred schema change; this at least makes the failure legible.)
 */
export function isSerialCollision(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") return false;
  const target = err.meta?.target;
  const fields = Array.isArray(target) ? target : typeof target === "string" ? [target] : [];
  return fields.some((f) => String(f).toLowerCase().includes("serial"));
}

export interface EventContext {
  name: string;
  startDate: Date;
  endDate: Date;
  venue: string | null;
  city: string | null;
  country: string | null;
  organizationName: string;
  organizationLogo: string | null;
  cmeHours: number | null;
  // Narrowed to AccreditationEntry so it satisfies the renderer's
  // CertificateEventContext shape (it expects the body field to be the
  // closed union, not a wide string).
  accreditations: AccreditationEntry[];
  settings: unknown;
}

export async function loadEventContext(eventId: string): Promise<EventContext | null> {
  const event = await db.event.findUnique({
    where: { id: eventId },
    select: {
      name: true, startDate: true, endDate: true,
      venue: true, city: true, country: true,
      cmeHours: true, settings: true,
      organization: { select: { name: true, logo: true } },
    },
  });
  if (!event) return null;
  const settings = event.settings && typeof event.settings === "object" && !Array.isArray(event.settings)
    ? (event.settings as Record<string, unknown>) : {};
  const cme = settings.cme && typeof settings.cme === "object" && !Array.isArray(settings.cme)
    ? settings.cme as Record<string, unknown> : {};
  const accreditations = (cme.accreditations as AccreditationEntry[]) ?? [];
  return {
    name: event.name,
    startDate: event.startDate,
    endDate: event.endDate,
    venue: event.venue,
    city: event.city,
    country: event.country,
    organizationName: event.organization.name,
    organizationLogo: event.organization.logo,
    cmeHours: event.cmeHours == null ? null : Number(event.cmeHours),
    accreditations,
    settings: event.settings,
  };
}

export async function loadRecipient(
  registrationId: string | null,
  speakerId: string | null,
): Promise<CertificateData["recipient"] | null> {
  if (registrationId) {
    const reg = await db.registration.findUnique({
      where: { id: registrationId },
      select: {
        attendee: {
          select: { title: true, firstName: true, lastName: true, email: true,
            organization: true, jobTitle: true, city: true, country: true },
        },
      },
    });
    const a = reg?.attendee;
    if (!a) return null;
    return {
      title: a.title,
      firstName: a.firstName,
      lastName: a.lastName,
      fullName: formatRecipientName(a.title, a.firstName, a.lastName),
      organization: a.organization,
      jobTitle: a.jobTitle,
      city: a.city,
      country: a.country,
    };
  }
  if (speakerId) {
    const s = await db.speaker.findUnique({
      where: { id: speakerId },
      select: {
        title: true, firstName: true, lastName: true, email: true,
        organization: true, jobTitle: true, city: true, country: true,
      },
    });
    if (!s) return null;
    return {
      title: s.title,
      firstName: s.firstName,
      lastName: s.lastName,
      fullName: formatRecipientName(s.title, s.firstName, s.lastName),
      organization: s.organization,
      jobTitle: s.jobTitle,
      city: s.city,
      country: s.country,
    };
  }
  return null;
}

/**
 * Title-prefixed recipient name for a certificate (Sep 16, 2026).
 *
 * This carried its own inline { DR: "Dr.", … } map, a third copy of a mapping
 * that already lives once as TITLE_LABELS in @/lib/utils. Identical behaviour,
 * so nothing changes today, but three copies is how a new Title enum value
 * gets added to one and silently dropped from certificates.
 *
 * Kept as a named re-export rather than sweeping the three call sites: the
 * failure mode of a missed call site is a SILENTLY dropped honorific on a
 * certificate, which no reviewer notices. Not the same function as
 * pdf/document-layout's formatRecipientName, which is deliberately tolerant of
 * an already-formatted "Dr." because its callers disagree on the shape. Every
 * caller here passes the raw Prisma enum, so the strict one is correct.
 */
export const formatRecipientName = formatPersonName;

export async function allocateSerial(
  eventId: string,
  type: CertificateType,
  // tenancy: the event's org (nullable for legacy/master). Stamped on the
  // create branch of the counter upsert so the atomic INSERT…ON CONFLICT
  // against a policy-invisible row can't raise a spurious unique violation
  // under RLS (the RegistrationSerialCounter flat-column reason). Caller runs
  // inside runWithTenant so the per-op SET LOCAL applies; null → passthrough.
  organizationId: string | null,
): Promise<string> {
  const counter = await db.certificateSerialCounter.upsert({
    where: { eventId_type: { eventId, type } },
    create: { eventId, type, lastSerial: 1, organizationId },
    // Self-heal on the update branch (sweep review M3 — the
    // registration-serial.ts precedent): a counter row born NULL-org (old
    // container during the blue-green window) is forever-lived and would
    // otherwise never heal. Conditional, unlike the precedent, because this
    // param is nullable (legacy callers thread null) — an unconditional
    // re-stamp would null out an already-backfilled value.
    update: { lastSerial: { increment: 1 }, ...(organizationId ? { organizationId } : {}) },
    select: { lastSerial: true },
  });
  const code = await db.event.findUnique({ where: { id: eventId }, select: { code: true } });
  const prefix = code?.code ?? eventId.slice(0, 6).toUpperCase();
  return `${prefix}-${type.slice(0, 3)}-${String(counter.lastSerial).padStart(4, "0")}`;
}

export async function loadPosterAbstractTitle(speakerId: string, eventId: string): Promise<string | null> {
  const abstract = await db.abstract.findFirst({
    where: { eventId, presentationType: "POSTER", status: "ACCEPTED", speakerId },
    select: { title: true },
    orderBy: { createdAt: "asc" },
  });
  return abstract?.title ?? null;
}
