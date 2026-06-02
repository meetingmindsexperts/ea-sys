/**
 * Certificates → CME settings endpoint.
 *
 * GET — returns the event's cmeHours + accreditations[] + design-approval state.
 * PATCH — updates the same fields. Writes cmeHours to its dedicated column;
 *         writes accreditations + designApproved* into Event.settings.cme.*.
 *
 * Scope:
 *   - ADMIN / ORGANIZER / SUPER_ADMIN can read + edit cmeHours and accreditations.
 *   - SUPER_ADMIN ONLY can flip designApprovedBy / designApprovedAt — this is
 *     the gate that unlocks the Phase C Issue button for CME certificates,
 *     so it's restricted to the role that owns design sign-off.
 *
 * Kept as its own narrow surface (rather than extending the catch-all event
 * PUT) because: (a) the PUT route is already complex and accepting a JSON
 * mutation under settings.cme is risky to thread into the existing safe-fields
 * whitelist, (b) the design-approval flag has its own RBAC envelope, and
 * (c) the certificates dashboard UI talks to one endpoint that owns one
 * concern.
 */

import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { denyReviewer } from "@/lib/auth-guards";
import { apiLogger } from "@/lib/logger";
import { readEventCmeSettings } from "@/lib/certificates/sample-data";
import type { EventCmeSettings, CertificateTemplate, EventCertificateTemplates } from "@/lib/certificates/types";
import type { CertificateType } from "@prisma/client";

const CERT_TYPES: CertificateType[] = ["ATTENDANCE", "PRESENTER", "POSTER", "CME"];

/**
 * Pull the per-cert-type templates map from `Event.settings.certificateTemplates`.
 * Backward compat — if the old singular `certificateTemplate` exists from
 * Phase 1, seed all four type slots from it so an organizer who already
 * configured a single template doesn't lose work when the storage shape
 * changes.
 */
function readCertTemplates(settings: unknown): EventCertificateTemplates {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return {};
  const obj = settings as Record<string, unknown>;
  const t = obj.certificateTemplates;
  if (t && typeof t === "object" && !Array.isArray(t)) {
    return t as EventCertificateTemplates;
  }
  // Backward compat: migrate from old single-template shape.
  const legacy = obj.certificateTemplate;
  if (legacy && typeof legacy === "object" && !Array.isArray(legacy)) {
    const seed = legacy as CertificateTemplate;
    return { ATTENDANCE: seed, PRESENTER: seed, POSTER: seed, CME: seed };
  }
  return {};
}

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

// Per-event certificate template fields — organizer-controlled visual
// elements (post-2026-06-01 redesign). Every field optional so the UI
// can patch one slice at a time (just upload a banner, or just edit body,
// etc.). URL fields accept the project's standard `/uploads/...` paths.
const signatureSchema = z.object({
  image: z.string().max(500).nullable().optional(),
  name: z.string().min(1).max(120).trim(),
  lines: z.array(z.string().max(200)).max(6).default([]),
});
const footerLogoSchema = z.object({
  label: z.string().max(60).optional(),
  image: z.string().min(1).max(500),
});
const templateSchema = z.object({
  headerImage: z.string().max(500).nullable().optional(),
  titleText: z.string().max(120).optional(),
  titleColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, "must be a 6-digit hex color").optional(),
  bodyTemplate: z.string().max(4000).optional(),
  signatures: z.array(signatureSchema).max(4).optional(),
  footerLogos: z.array(footerLogoSchema).max(6).optional(),
  footerText: z.string().max(800).optional(),
});

// Per-type templates map — each key is a CertificateType, value is a
// partial template. PATCH accepts updates to any subset of types in one
// call (so the UI can save a whole bulk-edit at once).
const templatesByTypeSchema = z
  .object({
    ATTENDANCE: templateSchema.optional(),
    PRESENTER: templateSchema.optional(),
    POSTER: templateSchema.optional(),
    CME: templateSchema.optional(),
  })
  .strict()
  .optional();

const patchSchema = z
  .object({
    // Allow nulling out to "no CME" — cap 999.9, decimal allowed up to 1dp.
    cmeHours: z.number().min(0).max(999.9).nullable().optional(),
    accreditations: z.array(accreditationSchema).max(5).optional(),
    // SUPER_ADMIN flips this once they (and the CEO/MD via screenshare
    // review) have signed off the cert design. Server enforces the role
    // gate; UI hides the checkbox for non-SUPER_ADMIN.
    designApproved: z.boolean().optional(),
    // Per-cert-type templates — one template per type. The PATCH can
    // include zero, one, or all four type slots. Each slot accepts a
    // partial template (just headerImage, just signatures, etc.) and is
    // merged into the existing persisted template for that type.
    templates: templatesByTypeSchema,
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
    const templates = readCertTemplates(event.settings);
    return NextResponse.json({
      cmeHours: event.cmeHours == null ? null : Number(event.cmeHours),
      accreditations: cme.accreditations ?? [],
      designApprovedBy: cme.designApprovedBy ?? null,
      designApprovedAt: cme.designApprovedAt ?? null,
      // Always return all four type slots — unconfigured slots come back
      // as empty templates (UI then shows the default copy + empty
      // upload widgets). Caller can rely on `templates.CME` etc. being
      // present without an existence check.
      templates: Object.fromEntries(
        CERT_TYPES.map((type) => {
          const t = templates[type] ?? {};
          return [type, {
            headerImage: t.headerImage ?? null,
            titleText: t.titleText ?? null,
            titleColor: t.titleColor ?? null,
            bodyTemplate: t.bodyTemplate ?? null,
            signatures: t.signatures ?? [],
            footerLogos: t.footerLogos ?? [],
            footerText: t.footerText ?? null,
          }];
        }),
      ),
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

    // Design-approval flag is SUPER_ADMIN-only. Caught here BEFORE the
    // event lookup so a curious ADMIN can't probe by event existence.
    if (parsed.data.designApproved !== undefined && session.user.role !== "SUPER_ADMIN") {
      apiLogger.warn({
        msg: "cert-settings:design-approval-forbidden",
        eventId,
        userId: session.user.id,
        role: session.user.role,
      });
      return NextResponse.json(
        {
          error: "Only SUPER_ADMIN can flip the design-approval flag.",
          code: "FORBIDDEN_FIELD",
        },
        { status: 403 },
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
    if (parsed.data.designApproved !== undefined) {
      if (parsed.data.designApproved) {
        nextCme.designApprovedBy = session.user.id;
        nextCme.designApprovedAt = new Date().toISOString();
      } else {
        // Explicitly unset both fields when un-approving so the gate
        // re-locks. Don't keep a stale designApprovedBy lingering.
        delete nextCme.designApprovedBy;
        delete nextCme.designApprovedAt;
      }
    }

    // Merge per-type template patches into the existing templates map.
    // Each type slot is independent — patching ATTENDANCE doesn't touch
    // CME. Inside a slot, fields are merged (partial patch — keeping
    // signatures intact when only headerImage is sent, etc.).
    const currentTemplates = readCertTemplates(currentSettings);
    const nextTemplates: EventCertificateTemplates = { ...currentTemplates };
    if (parsed.data.templates) {
      for (const type of CERT_TYPES) {
        const slot = parsed.data.templates[type];
        if (!slot) continue;
        const prev: CertificateTemplate = nextTemplates[type] ?? {};
        const merged: CertificateTemplate = { ...prev };
        if (slot.headerImage !== undefined) merged.headerImage = slot.headerImage;
        if (slot.titleText !== undefined) merged.titleText = slot.titleText;
        if (slot.titleColor !== undefined) merged.titleColor = slot.titleColor;
        if (slot.bodyTemplate !== undefined) merged.bodyTemplate = slot.bodyTemplate;
        if (slot.signatures !== undefined) merged.signatures = slot.signatures;
        if (slot.footerLogos !== undefined) merged.footerLogos = slot.footerLogos;
        if (slot.footerText !== undefined) merged.footerText = slot.footerText;
        nextTemplates[type] = merged;
      }
    }

    const nextSettings = {
      ...currentSettings,
      cme: nextCme,
      certificateTemplates: nextTemplates,
      // Drop the legacy singular key if it was used to seed the per-type
      // map above. Cleans up the JSON over time so future reads don't
      // re-trigger the backward-compat branch.
      certificateTemplate: undefined,
    };

    const updated = await db.event.update({
      where: { id: eventId },
      data: {
        ...(parsed.data.cmeHours !== undefined && { cmeHours: parsed.data.cmeHours }),
        // Cast through unknown — EventCmeSettings is a precise typed shape
        // while Prisma.InputJsonValue is the open Json contract; the two
        // don't overlap structurally even though every value in our shape
        // is JSON-serializable. Safe at runtime.
        settings: nextSettings as unknown as Prisma.InputJsonValue,
      },
      select: { id: true, cmeHours: true, settings: true },
    });

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
            designApproved: parsed.data.designApproved,
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
      changedApproval: parsed.data.designApproved !== undefined,
    });

    const finalCme = readEventCmeSettings(updated.settings);
    const finalTemplates = readCertTemplates(updated.settings);
    return NextResponse.json({
      cmeHours: updated.cmeHours == null ? null : Number(updated.cmeHours),
      accreditations: finalCme.accreditations ?? [],
      designApprovedBy: finalCme.designApprovedBy ?? null,
      designApprovedAt: finalCme.designApprovedAt ?? null,
      templates: Object.fromEntries(
        CERT_TYPES.map((type) => {
          const t = finalTemplates[type] ?? {};
          return [type, {
            headerImage: t.headerImage ?? null,
            titleText: t.titleText ?? null,
            titleColor: t.titleColor ?? null,
            bodyTemplate: t.bodyTemplate ?? null,
            signatures: t.signatures ?? [],
            footerLogos: t.footerLogos ?? [],
            footerText: t.footerText ?? null,
          }];
        }),
      ),
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "cert-settings:patch-failed", eventId });
    return NextResponse.json(
      { error: "Failed to update certificate settings" },
      { status: 500 },
    );
  }
}
