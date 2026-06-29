/**
 * Certificates → CME settings endpoint.
 *
 * GET — returns the event's cmeHours + accreditations[].
 * PATCH — updates the same fields. Writes cmeHours to its dedicated
 *   column; writes accreditations into Event.settings.cme.accreditations.
 *
 * Templates were moved out of this route on 2026-06-02 — they live in
 * the CertificateTemplate table with their own CRUD at
 * `/api/events/[id]/certificates/templates`. The design-approval gate
 * was also dropped on the same date (any ADMIN/ORGANIZER can issue).
 *
 * Scope: ADMIN / ORGANIZER / SUPER_ADMIN.
 */

import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { denyReviewer } from "@/lib/auth-guards";
import { apiLogger } from "@/lib/logger";
import { updateEventSettings } from "@/lib/event-settings";
import { readEventCmeSettings } from "@/lib/certificates/sample-data";
import type { EventCmeSettings } from "@/lib/certificates/types";

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

const accreditationSchema = z.object({
  body: z.enum(["DHA", "DOH", "SCFHS", "EACCME", "ACCME", "OTHER"]),
  reference: z.string().min(1).max(120).trim(),
  // Optional per-accreditor hour override — defaults to the event's
  // global cmeHours when omitted. Useful when DHA awards 18 hours but
  // EACCME awards 12 ECMECs for the same event.
  hours: z.number().min(0).max(999.9).optional(),
  // Verbatim wording override — accreditors who require exact text
  // (EACCME's "designated for a maximum of N ECMECs"). Capped at 500
  // chars to keep the cert layout sane. Never raw HTML — text only.
  officialStatement: z.string().max(500).optional(),
});

const patchSchema = z
  .object({
    // Allow nulling out to "no CME" — cap 999.9, decimal allowed up to 1dp.
    cmeHours: z.number().min(0).max(999.9).nullable().optional(),
    accreditations: z.array(accreditationSchema).max(5).optional(),
  })
  .strict();

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const denied = denyReviewer(session);
    if (denied) return denied;
    if (!session.user.organizationId) {
      apiLogger.warn({ msg: "cert-settings:no-org", userId: session.user.id });
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: session.user.organizationId },
      select: { id: true, cmeHours: true, settings: true },
    });
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const cme = readEventCmeSettings(event.settings);
    return NextResponse.json({
      cmeHours: event.cmeHours == null ? null : Number(event.cmeHours),
      accreditations: cme.accreditations ?? [],
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "cert-settings:get-failed" });
    return NextResponse.json(
      { error: "Failed to load certificate settings" },
      { status: 500 },
    );
  }
}

export async function PATCH(req: Request, { params }: RouteParams) {
  let eventId: string | undefined;
  try {
    const [p, session, body] = await Promise.all([
      params,
      auth(),
      req.json().catch(() => ({})),
    ]);
    eventId = p.eventId;

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const denied = denyReviewer(session);
    if (denied) return denied;
    if (!session.user.organizationId) {
      apiLogger.warn({ msg: "cert-settings:no-org", userId: session.user.id });
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn({
        msg: "cert-settings:validation-failed",
        eventId,
        userId: session.user.id,
        errors: parsed.error.flatten(),
      });
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: session.user.organizationId },
      select: { id: true, settings: true },
    });
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    // Compose the new settings.cme blob — preserve unrelated settings keys.
    const currentSettings =
      event.settings && typeof event.settings === "object" && !Array.isArray(event.settings)
        ? (event.settings as Record<string, unknown>)
        : {};
    const currentCme = readEventCmeSettings(currentSettings);

    const nextCme: EventCmeSettings = { ...currentCme };
    if (parsed.data.accreditations !== undefined) {
      nextCme.accreditations = parsed.data.accreditations;
    }
    // Strip the obsolete design-approval fields whenever this route writes —
    // gate was removed 2026-06-02 and the lingering values would just
    // confuse audit-trail readers.
    delete nextCme.designApprovedBy;
    delete nextCme.designApprovedAt;

    // Settings (cme blob) goes through the atomic merge helper. The
    // scalar cmeHours column is updated separately when provided.
    const mergedSettings = await updateEventSettings(eventId, { cme: nextCme });

    let finalCmeHours: Prisma.Decimal | number | null;
    if (parsed.data.cmeHours !== undefined) {
      const updated = await db.event.update({
        where: { id: eventId },
        data: { cmeHours: parsed.data.cmeHours },
        select: { cmeHours: true },
      });
      finalCmeHours = updated.cmeHours;
    } else {
      const fresh = await db.event.findUnique({
        where: { id: eventId },
        select: { cmeHours: true },
      });
      finalCmeHours = fresh?.cmeHours ?? null;
    }

    db.auditLog
      .create({
        data: {
          eventId,
          userId: session.user.id,
          action: "UPDATE",
          entityType: "Event",
          entityId: eventId,
          changes: {
            domain: "cme-settings",
            cmeHours: parsed.data.cmeHours,
            accreditationsCount: parsed.data.accreditations?.length,
          },
        },
      })
      .catch((err) => apiLogger.warn({ err, msg: "cert-settings:audit-failed", eventId }));

    apiLogger.info({
      msg: "cert-settings:updated",
      eventId,
      userId: session.user.id,
      role: session.user.role,
      changedHours: parsed.data.cmeHours !== undefined,
      changedAccreditations: parsed.data.accreditations !== undefined,
    });

    const finalCme = readEventCmeSettings(mergedSettings);
    return NextResponse.json({
      cmeHours: finalCmeHours == null ? null : Number(finalCmeHours),
      accreditations: finalCme.accreditations ?? [],
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "cert-settings:patch-failed", eventId });
    return NextResponse.json(
      { error: "Failed to update certificate settings" },
      { status: 500 },
    );
  }
}
