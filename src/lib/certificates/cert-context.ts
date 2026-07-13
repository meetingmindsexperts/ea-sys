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

export function formatRecipientName(title: string | null, first: string, last: string): string {
  const map: Record<string, string> = { DR: "Dr.", MR: "Mr.", MRS: "Mrs.", MS: "Ms.", PROF: "Prof." };
  const t = title ? `${map[title] ?? ""} ` : "";
  return `${t}${first} ${last}`.trim();
}

export async function allocateSerial(eventId: string, type: CertificateType): Promise<string> {
  const counter = await db.certificateSerialCounter.upsert({
    where: { eventId_type: { eventId, type } },
    create: { eventId, type, lastSerial: 1 },
    update: { lastSerial: { increment: 1 } },
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
