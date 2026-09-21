/**
 * MCP / agent tools for the certificate domain.
 *
 * v3 multi-template model (2026-06-02). Templates live in the
 * CertificateTemplate Prisma table — an event can have any number of
 * Attendance and Appreciation templates with their own background PDF
 * + positioned text boxes. Eligibility stays category-scoped (one cert
 * per recipient per category per event).
 *
 * Tools:
 *   - list_certificate_templates    GET  all templates + CME settings
 *   - create_certificate_template   POST a new template row (name + category)
 *   - update_certificate_template   PATCH a specific template by id
 *   - update_cme_settings           PATCH event-level cmeHours + accreditations
 *
 * Asset URLs must be a `/uploads/certificates/...` path or an https
 * Supabase URL (validated by validateBackgroundPdfUrl — path-traversal +
 * host allowlist). Upload PDFs via POST /api/upload/pdf first (10MB cap,
 * magic-byte validated); PNG/JPG also accepted and server-converted to PDF.
 */

import { Prisma } from "@prisma/client";
import { db, tenantTransaction } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { updateEventSettings } from "@/lib/event-settings";
import { validateBackgroundPdfUrl } from "@/lib/certificates/pdf-loader";
import { CERTIFICATE_FONT_NAMES } from "@/lib/certificates/template-box-schema";
import type { AgentContext, ToolExecutor } from "./_shared";

const CERT_CATEGORIES = ["ATTENDANCE", "APPRECIATION"] as const;
type CertCategory = (typeof CERT_CATEGORIES)[number];

const ACCREDITOR_BODIES = ["DHA", "DOH", "SCFHS", "EACCME", "ACCME", "OTHER"] as const;

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
// This validator stays hand-rolled (it returns JSON-RPC `{error, code}` rather
// than throwing, so it can't reuse the REST Zod schema) but the font list is
// shared, so the twelve names can't drift between the REST and MCP doors.
const FONT_NAMES = new Set<string>(CERTIFICATE_FONT_NAMES);

interface TextBox {
  id: string;
  content: string;
  x: number;
  y: number;
  width: number;
  height: number;
  font: string;
  size: number;
  color: string;
  align: "left" | "center" | "right";
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function readSettings(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw as Record<string, unknown>;
}

function readCme(settings: Record<string, unknown>): Record<string, unknown> {
  const c = settings.cme;
  if (!c || typeof c !== "object" || Array.isArray(c)) return {};
  return c as Record<string, unknown>;
}

function validatePdfUrl(url: unknown, field: string): string | { error: string; code: string } {
  if (typeof url !== "string" || url.length === 0) {
    return { error: `${field} must be a non-empty string`, code: "INVALID_PDF_URL" };
  }
  // The prefix-only LOCAL_URL_RE let `/uploads/../../.env` through; delegate to
  // the shared validator so the agent surface enforces the same path-traversal /
  // https-host-allowlist guard as the read-side loader (B1).
  const check = validateBackgroundPdfUrl(url);
  if (!check.ok) {
    return {
      error: `${field} is invalid: ${check.reason}. Upload via POST /api/upload/pdf first.`,
      code: "INVALID_PDF_URL",
    };
  }
  return url;
}

function validateTextBoxes(input: unknown): TextBox[] | { error: string; code: string } {
  if (!Array.isArray(input) || input.length > 40) {
    return { error: "textBoxes must be an array (max 40 entries)", code: "INVALID_FIELD" };
  }
  const out: TextBox[] = [];
  for (const [i, raw] of input.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { error: `textBoxes[${i}] must be an object`, code: "INVALID_FIELD" };
    }
    const b = raw as Record<string, unknown>;
    if (typeof b.id !== "string" || b.id.length === 0 || b.id.length > 64) {
      return { error: `textBoxes[${i}].id must be a non-empty string (max 64 chars)`, code: "INVALID_FIELD" };
    }
    if (typeof b.content !== "string" || b.content.length > 500) {
      return { error: `textBoxes[${i}].content must be string (max 500 chars)`, code: "INVALID_FIELD" };
    }
    for (const dim of ["x", "y", "width", "height"] as const) {
      const v = b[dim];
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 20000) {
        return { error: `textBoxes[${i}].${dim} must be number in [0, 20000]`, code: "INVALID_FIELD" };
      }
      if ((dim === "width" || dim === "height") && v < 1) {
        return { error: `textBoxes[${i}].${dim} must be >= 1`, code: "INVALID_FIELD" };
      }
    }
    if (typeof b.font !== "string" || !FONT_NAMES.has(b.font)) {
      return { error: `textBoxes[${i}].font must be one of pdf-lib's 12 standard fonts`, code: "INVALID_FIELD" };
    }
    if (typeof b.size !== "number" || b.size < 4 || b.size > 120) {
      return { error: `textBoxes[${i}].size must be number in [4, 120]`, code: "INVALID_FIELD" };
    }
    if (typeof b.color !== "string" || !HEX_COLOR_RE.test(b.color)) {
      return { error: `textBoxes[${i}].color must be 6-digit hex e.g. #1a2e5a`, code: "INVALID_FIELD" };
    }
    if (b.align !== "left" && b.align !== "center" && b.align !== "right") {
      return { error: `textBoxes[${i}].align must be one of: left, center, right`, code: "INVALID_FIELD" };
    }
    out.push({
      id: b.id,
      content: b.content,
      x: b.x as number,
      y: b.y as number,
      width: b.width as number,
      height: b.height as number,
      font: b.font,
      size: b.size,
      color: b.color,
      align: b.align,
    });
  }
  return out;
}

// ── Tool: list_certificate_templates ────────────────────────────────────────

async function listCertificateTemplates(_input: Record<string, unknown>, ctx: AgentContext) {
  // tenancy: swept CertificateTemplate read (via the event relation) runs
  // inside the caller's org.
  const event = await runWithTenant(ctx.organizationId, () =>
    db.event.findFirst({
      where: { id: ctx.eventId, organizationId: ctx.organizationId },
      select: {
        id: true,
        cmeHours: true,
        settings: true,
        certificateTemplates: {
          orderBy: [{ category: "asc" }, { sortOrder: "asc" }, { createdAt: "asc" }],
          select: {
            id: true,
            name: true,
            category: true,
            backgroundPdfUrl: true,
            textBoxes: true,
            sortOrder: true,
            role: true,
            cmeHours: true,
            autoIssueOnSurvey: true,
            autoIssueTag: true,
            createdAt: true,
            updatedAt: true,
            _count: { select: { issuedCertificates: true, issueRuns: true } },
          },
        },
      },
    }),
  );
  if (!event) return { error: "Event not found", code: "EVENT_NOT_FOUND" };

  const settings = readSettings(event.settings);
  const cme = readCme(settings);
  return {
    eventId: event.id,
    cmeHours: event.cmeHours == null ? null : Number(event.cmeHours),
    accreditations: cme.accreditations ?? [],
    templates: event.certificateTemplates,
  };
}

// ── Tool: create_certificate_template ───────────────────────────────────────

async function createCertificateTemplate(input: Record<string, unknown>, ctx: AgentContext) {
  if (typeof input.name !== "string" || input.name.trim().length === 0 || input.name.length > 120) {
    return { error: "name is required (string, max 120 chars)", code: "INVALID_FIELD" };
  }
  if (typeof input.category !== "string" || !CERT_CATEGORIES.includes(input.category as CertCategory)) {
    return {
      error: `category must be one of: ${CERT_CATEGORIES.join(", ")}`,
      code: "INVALID_CATEGORY",
    };
  }
  const category = input.category as CertCategory;

  let backgroundPdfUrl: string | null = null;
  if (input.backgroundPdfUrl !== undefined && input.backgroundPdfUrl !== null) {
    const v = validatePdfUrl(input.backgroundPdfUrl, "backgroundPdfUrl");
    if (typeof v !== "string") return v;
    backgroundPdfUrl = v;
  }

  let textBoxes: TextBox[] = [];
  if (input.textBoxes !== undefined) {
    const v = validateTextBoxes(input.textBoxes);
    if (!Array.isArray(v)) return v;
    textBoxes = v;
  }

  // No per-template cover email since Sep 18, 2026: the event's Certificate
  // Delivery email template for the category is the wording (edit it under
  // Communications → Email Templates, or with update_email_template).

  // Optional role label ({{role}} token) + static per-template CME hours
  // ({{cmeHours}}, overrides event-level when set).
  let role: string | null = null;
  if (input.role !== undefined && input.role !== null) {
    if (typeof input.role !== "string" || input.role.length > 120) {
      return { error: "role must be a string (max 120 chars)", code: "INVALID_FIELD" };
    }
    role = input.role.trim() || null;
  }
  let cmeHours: number | null = null;
  if (input.cmeHours !== undefined && input.cmeHours !== null) {
    if (typeof input.cmeHours !== "number" || Number.isNaN(input.cmeHours) || input.cmeHours < 0 || input.cmeHours > 999) {
      return { error: "cmeHours must be a number between 0 and 999", code: "INVALID_FIELD" };
    }
    cmeHours = input.cmeHours;
  }

  // Phase 2 survey-gated auto-issue config.
  let autoIssueOnSurvey = false;
  if (input.autoIssueOnSurvey !== undefined && input.autoIssueOnSurvey !== null) {
    if (typeof input.autoIssueOnSurvey !== "boolean") {
      return { error: "autoIssueOnSurvey must be a boolean", code: "INVALID_FIELD" };
    }
    autoIssueOnSurvey = input.autoIssueOnSurvey;
  }
  let autoIssueTag: string | null = null;
  if (input.autoIssueTag !== undefined && input.autoIssueTag !== null) {
    if (typeof input.autoIssueTag !== "string" || input.autoIssueTag.length > 120) {
      return { error: "autoIssueTag must be a string (max 120 chars)", code: "INVALID_FIELD" };
    }
    autoIssueTag = input.autoIssueTag.trim() || null;
  }

  // Verify event is in caller's org.
  const event = await db.event.findFirst({
    where: { id: ctx.eventId, organizationId: ctx.organizationId },
    select: { id: true },
  });
  if (!event) return { error: "Event not found", code: "EVENT_NOT_FOUND" };

  // Wrap aggregate+create in a transaction so two concurrent MCP calls
  // (or one dashboard + one MCP) can't both compute the same nextOrder.
  // Same rationale as the REST POST route — sortOrder isn't unique-
  // constrained but operator-visible position semantics rely on it.
  const eventIdLocked = ctx.eventId;
  const trimmedName = input.name.trim();
  // tenancy: wrap the aggregate+create tx in the caller's org so the swept
  // CertificateTemplate write runs under SET LOCAL on the platform.
  const template = await runWithTenant(ctx.organizationId, () =>
    tenantTransaction(async (tx) => {
    const maxOrder = await tx.certificateTemplate.aggregate({
      where: { eventId: eventIdLocked, category },
      _max: { sortOrder: true },
    });
    const sortOrder = (maxOrder._max.sortOrder ?? -1) + 1;
    return tx.certificateTemplate.create({
      data: {
        eventId: eventIdLocked,
        organizationId: ctx.organizationId, // tenancy
        name: trimmedName,
        category,
        backgroundPdfUrl,
        textBoxes: textBoxes as unknown as Prisma.InputJsonValue,
        sortOrder,
        role,
        cmeHours,
        autoIssueOnSurvey,
        autoIssueTag,
      },
    });
    }),
  );

  db.auditLog
    .create({
      data: {
        eventId: ctx.eventId,
        userId: ctx.userId,
        action: "CREATE",
        entityType: "CertificateTemplate",
        entityId: template.id,
        changes: { source: ctx.source, name: template.name, category },
      },
    })
    .catch((err) => apiLogger.warn({ err, msg: "cert-template-mcp:audit-failed-create" }));

  apiLogger.info({
    msg: "cert-template-mcp:created",
    eventId: ctx.eventId,
    userId: ctx.userId,
    templateId: template.id,
    category,
    name: template.name,
  });

  return { ok: true, template };
}

// ── Tool: update_certificate_template ───────────────────────────────────────

async function updateCertificateTemplate(input: Record<string, unknown>, ctx: AgentContext) {
  if (typeof input.templateId !== "string" || input.templateId.length === 0) {
    return { error: "templateId is required", code: "INVALID_FIELD" };
  }
  const templateId = input.templateId;

  // tenancy: swept CertificateTemplate read runs inside the caller's org.
  const template = await runWithTenant(ctx.organizationId, () =>
    db.certificateTemplate.findFirst({
      where: {
        id: templateId,
        event: { id: ctx.eventId, organizationId: ctx.organizationId },
      },
      select: { id: true },
    }),
  );
  if (!template) return { error: "Template not found", code: "TEMPLATE_NOT_FOUND" };

  const data: Prisma.CertificateTemplateUpdateInput = {};
  if (input.name !== undefined) {
    if (typeof input.name !== "string" || input.name.trim().length === 0 || input.name.length > 120) {
      return { error: "name must be string (max 120 chars, non-empty when trimmed)", code: "INVALID_FIELD" };
    }
    data.name = input.name.trim();
  }
  if (input.backgroundPdfUrl !== undefined) {
    if (input.backgroundPdfUrl === null) {
      data.backgroundPdfUrl = null;
    } else {
      const v = validatePdfUrl(input.backgroundPdfUrl, "backgroundPdfUrl");
      if (typeof v !== "string") return v;
      data.backgroundPdfUrl = v;
    }
  }
  if (input.textBoxes !== undefined) {
    const v = validateTextBoxes(input.textBoxes);
    if (!Array.isArray(v)) return v;
    data.textBoxes = v as unknown as Prisma.InputJsonValue;
  }
  if (input.sortOrder !== undefined) {
    if (typeof input.sortOrder !== "number" || input.sortOrder < 0 || input.sortOrder > 9999) {
      return { error: "sortOrder must be a non-negative integer (max 9999)", code: "INVALID_FIELD" };
    }
    data.sortOrder = input.sortOrder;
  }
  // Role label + static per-template CME hours — pass null to clear.
  if (input.role !== undefined) {
    if (input.role === null) {
      data.role = null;
    } else if (typeof input.role !== "string" || input.role.length > 120) {
      return { error: "role must be a string (max 120 chars) or null", code: "INVALID_FIELD" };
    } else {
      data.role = input.role.trim() || null;
    }
  }
  if (input.cmeHours !== undefined) {
    if (input.cmeHours === null) {
      data.cmeHours = null;
    } else if (typeof input.cmeHours !== "number" || Number.isNaN(input.cmeHours) || input.cmeHours < 0 || input.cmeHours > 999) {
      return { error: "cmeHours must be a number between 0 and 999, or null", code: "INVALID_FIELD" };
    } else {
      data.cmeHours = input.cmeHours;
    }
  }
  // Phase 2 survey-gated auto-issue config.
  if (input.autoIssueOnSurvey !== undefined) {
    if (typeof input.autoIssueOnSurvey !== "boolean") {
      return { error: "autoIssueOnSurvey must be a boolean", code: "INVALID_FIELD" };
    }
    data.autoIssueOnSurvey = input.autoIssueOnSurvey;
  }
  if (input.autoIssueTag !== undefined) {
    if (input.autoIssueTag === null) {
      data.autoIssueTag = null;
    } else if (typeof input.autoIssueTag !== "string" || input.autoIssueTag.length > 120) {
      return { error: "autoIssueTag must be a string (max 120 chars) or null", code: "INVALID_FIELD" };
    } else {
      data.autoIssueTag = input.autoIssueTag.trim() || null;
    }
  }

  if (Object.keys(data).length === 0) {
    return {
      error:
        "Nothing to update — provide at least one of name / backgroundPdfUrl / textBoxes / sortOrder / role / cmeHours / autoIssueOnSurvey / autoIssueTag",
      code: "NOTHING_TO_UPDATE",
    };
  }

  // tenancy: swept CertificateTemplate write runs inside the caller's org.
  const updated = await runWithTenant(ctx.organizationId, () =>
    db.certificateTemplate.update({
      where: { id: templateId },
      data,
    }),
  );

  db.auditLog
    .create({
      data: {
        eventId: ctx.eventId,
        userId: ctx.userId,
        action: "UPDATE",
        entityType: "CertificateTemplate",
        entityId: updated.id,
        changes: { source: ctx.source, fieldsChanged: Object.keys(data) },
      },
    })
    .catch((err) => apiLogger.warn({ err, msg: "cert-template-mcp:audit-failed-update" }));

  apiLogger.info({
    msg: "cert-template-mcp:updated",
    eventId: ctx.eventId,
    userId: ctx.userId,
    templateId: updated.id,
    fieldsChanged: Object.keys(data),
  });

  return { ok: true, template: updated };
}

// ── Tool: update_cme_settings ───────────────────────────────────────────────

async function updateCmeSettings(input: Record<string, unknown>, ctx: AgentContext) {
  let cmeHoursValue: number | null | undefined = undefined;
  if (input.cmeHours !== undefined) {
    if (input.cmeHours === null) {
      cmeHoursValue = null;
    } else if (typeof input.cmeHours !== "number" || input.cmeHours < 0 || input.cmeHours > 999.9) {
      return { error: "cmeHours must be a number 0..999.9 or null", code: "INVALID_FIELD" };
    } else {
      cmeHoursValue = input.cmeHours;
    }
  }

  let cleanedAccreditations: Array<Record<string, unknown>> | undefined = undefined;
  if (input.accreditations !== undefined) {
    if (!Array.isArray(input.accreditations) || input.accreditations.length > 5) {
      return { error: "accreditations must be array (max 5 entries)", code: "INVALID_FIELD" };
    }
    const out: Array<Record<string, unknown>> = [];
    for (const [i, raw] of input.accreditations.entries()) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return { error: `accreditations[${i}] must be an object`, code: "INVALID_FIELD" };
      }
      const row = raw as Record<string, unknown>;
      if (typeof row.body !== "string" || !ACCREDITOR_BODIES.includes(row.body as typeof ACCREDITOR_BODIES[number])) {
        return {
          error: `accreditations[${i}].body must be one of: ${ACCREDITOR_BODIES.join(", ")}`,
          code: "INVALID_FIELD",
        };
      }
      if (typeof row.reference !== "string" || row.reference.trim().length === 0) {
        return { error: `accreditations[${i}].reference is required`, code: "INVALID_FIELD" };
      }
      const entry: Record<string, unknown> = {
        body: row.body,
        reference: row.reference.trim(),
      };
      if (row.hours !== undefined && row.hours !== null) {
        if (typeof row.hours !== "number" || row.hours < 0 || row.hours > 999.9) {
          return { error: `accreditations[${i}].hours invalid`, code: "INVALID_FIELD" };
        }
        entry.hours = row.hours;
      }
      if (row.officialStatement !== undefined && row.officialStatement !== null) {
        if (typeof row.officialStatement !== "string" || row.officialStatement.length > 500) {
          return { error: `accreditations[${i}].officialStatement too long`, code: "INVALID_FIELD" };
        }
        entry.officialStatement = row.officialStatement;
      }
      out.push(entry);
    }
    cleanedAccreditations = out;
  }

  if (cmeHoursValue === undefined && cleanedAccreditations === undefined) {
    return { error: "Provide at least one of cmeHours or accreditations", code: "NOTHING_TO_UPDATE" };
  }

  // tenancy: wrap for consistency with the other cert executors (Event is not
  // a swept cert table, so this is a harmless passthrough on master).
  const event = await runWithTenant(ctx.organizationId, () =>
    db.event.findFirst({
      where: { id: ctx.eventId, organizationId: ctx.organizationId },
      select: { id: true, settings: true },
    }),
  );
  if (!event) return { error: "Event not found", code: "EVENT_NOT_FOUND" };

  const settings = readSettings(event.settings);
  const prevCme = readCme(settings);
  const nextCme = { ...prevCme };
  if (cleanedAccreditations !== undefined) nextCme.accreditations = cleanedAccreditations;
  // Strip obsolete design-approval fields — gate removed 2026-06-02.
  delete nextCme.designApprovedBy;
  delete nextCme.designApprovedAt;

  // Settings (cme blob) goes through the atomic merge helper. The scalar
  // cmeHours column is updated separately when provided.
  await updateEventSettings(ctx.eventId, { cme: nextCme });
  if (cmeHoursValue !== undefined) {
    await db.event.update({
      where: { id: ctx.eventId },
      data: { cmeHours: cmeHoursValue },
      select: { id: true },
    });
  }

  db.auditLog
    .create({
      data: {
        eventId: ctx.eventId,
        userId: ctx.userId,
        action: "UPDATE",
        entityType: "Event",
        entityId: ctx.eventId,
        changes: {
          domain: "cme-settings",
          source: ctx.source,
          cmeHours: cmeHoursValue,
          accreditationsCount: cleanedAccreditations?.length,
        },
      },
    })
    .catch((err) => apiLogger.warn({ err, msg: "cme-settings-mcp:audit-failed" }));

  apiLogger.info({
    msg: "cme-settings-mcp:updated",
    eventId: ctx.eventId,
    userId: ctx.userId,
    changedHours: cmeHoursValue !== undefined,
    changedAccreditations: cleanedAccreditations !== undefined,
  });

  return {
    ok: true,
    cmeHours: cmeHoursValue === undefined ? "unchanged" : cmeHoursValue,
    accreditationsCount: cleanedAccreditations?.length ?? "unchanged",
  };
}

// ── Exports ─────────────────────────────────────────────────────────────────

export const CERTIFICATE_EXECUTORS: Record<string, ToolExecutor> = {
  list_certificate_templates: listCertificateTemplates,
  create_certificate_template: createCertificateTemplate,
  update_certificate_template: updateCertificateTemplate,
  update_cme_settings: updateCmeSettings,
};
