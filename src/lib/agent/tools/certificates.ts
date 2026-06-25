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
 *   - delete_certificate_template   DELETE a template (blocked if issued)
 *   - update_cme_settings           PATCH event-level cmeHours + accreditations
 *
 * Asset URLs must be `/uploads/...` paths (or `/certificates/...`).
 * Upload PDFs via POST /api/upload/pdf first (5MB cap, magic-byte
 * validated); PNG/JPG also accepted and server-converted to PDF.
 */

import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import type { AgentContext, ToolExecutor } from "./_shared";

const CERT_CATEGORIES = ["ATTENDANCE", "APPRECIATION"] as const;
type CertCategory = (typeof CERT_CATEGORIES)[number];

const ACCREDITOR_BODIES = ["DHA", "DOH", "SCFHS", "EACCME", "ACCME", "OTHER"] as const;

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const LOCAL_URL_RE = /^\/(uploads|certificates)\//;
const FONT_NAMES = new Set([
  "Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique",
  "Times-Roman", "Times-Bold", "Times-Italic", "Times-BoldItalic",
  "Courier", "Courier-Bold", "Courier-Oblique", "Courier-BoldOblique",
]);

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
  if (!LOCAL_URL_RE.test(url) || url.length > 500) {
    return {
      error: `${field} must be a /uploads/... or /certificates/... path (max 500 chars). Upload via POST /api/upload/pdf first.`,
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
  const event = await db.event.findFirst({
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
          createdAt: true,
          updatedAt: true,
          _count: { select: { issuedCertificates: true, issueRuns: true } },
        },
      },
    },
  });
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

  // Optional cover-email defaults. Both nullable — when null the Issue
  // dialog falls back to the per-category system default. min(1) when
  // set so a template doesn't carry an empty string.
  let emailSubject: string | null = null;
  let emailBody: string | null = null;
  if (input.emailSubject !== undefined && input.emailSubject !== null) {
    if (typeof input.emailSubject !== "string" || input.emailSubject.length === 0 || input.emailSubject.length > 200) {
      return { error: "emailSubject must be a non-empty string (max 200 chars)", code: "INVALID_FIELD" };
    }
    emailSubject = input.emailSubject;
  }
  if (input.emailBody !== undefined && input.emailBody !== null) {
    if (typeof input.emailBody !== "string" || input.emailBody.length === 0 || input.emailBody.length > 10000) {
      return { error: "emailBody must be a non-empty string (max 10000 chars; Tiptap HTML output)", code: "INVALID_FIELD" };
    }
    emailBody = input.emailBody;
  }

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
  const template = await db.$transaction(async (tx) => {
    const maxOrder = await tx.certificateTemplate.aggregate({
      where: { eventId: eventIdLocked, category },
      _max: { sortOrder: true },
    });
    const sortOrder = (maxOrder._max.sortOrder ?? -1) + 1;
    return tx.certificateTemplate.create({
      data: {
        eventId: eventIdLocked,
        name: trimmedName,
        category,
        backgroundPdfUrl,
        textBoxes: textBoxes as unknown as Prisma.InputJsonValue,
        sortOrder,
        emailSubject,
        emailBody,
        role,
        cmeHours,
      },
    });
  });

  db.auditLog
    .create({
      data: {
        eventId: ctx.eventId,
        userId: ctx.userId,
        action: "CREATE",
        entityType: "CertificateTemplate",
        entityId: template.id,
        changes: { source: "mcp", name: template.name, category },
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

  const template = await db.certificateTemplate.findFirst({
    where: {
      id: templateId,
      event: { id: ctx.eventId, organizationId: ctx.organizationId },
    },
    select: { id: true },
  });
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
  // Cover-email defaults — pass null to clear back to system default.
  if (input.emailSubject !== undefined) {
    if (input.emailSubject === null) {
      data.emailSubject = null;
    } else if (typeof input.emailSubject !== "string" || input.emailSubject.length === 0 || input.emailSubject.length > 200) {
      return { error: "emailSubject must be a non-empty string (max 200 chars) or null", code: "INVALID_FIELD" };
    } else {
      data.emailSubject = input.emailSubject;
    }
  }
  if (input.emailBody !== undefined) {
    if (input.emailBody === null) {
      data.emailBody = null;
    } else if (typeof input.emailBody !== "string" || input.emailBody.length === 0 || input.emailBody.length > 10000) {
      return { error: "emailBody must be a non-empty string (max 10000 chars; Tiptap HTML output) or null", code: "INVALID_FIELD" };
    } else {
      data.emailBody = input.emailBody;
    }
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

  if (Object.keys(data).length === 0) {
    return {
      error:
        "Nothing to update — provide at least one of name / backgroundPdfUrl / textBoxes / sortOrder / emailSubject / emailBody / role / cmeHours",
      code: "NOTHING_TO_UPDATE",
    };
  }

  const updated = await db.certificateTemplate.update({
    where: { id: templateId },
    data,
  });

  db.auditLog
    .create({
      data: {
        eventId: ctx.eventId,
        userId: ctx.userId,
        action: "UPDATE",
        entityType: "CertificateTemplate",
        entityId: updated.id,
        changes: { source: "mcp", fieldsChanged: Object.keys(data) },
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

// ── Tool: delete_certificate_template ───────────────────────────────────────

async function deleteCertificateTemplate(input: Record<string, unknown>, ctx: AgentContext) {
  if (typeof input.templateId !== "string" || input.templateId.length === 0) {
    return { error: "templateId is required", code: "INVALID_FIELD" };
  }
  const templateId = input.templateId;

  const template = await db.certificateTemplate.findFirst({
    where: {
      id: templateId,
      event: { id: ctx.eventId, organizationId: ctx.organizationId },
    },
    include: { _count: { select: { issuedCertificates: true, issueRuns: true } } },
  });
  if (!template) return { error: "Template not found", code: "TEMPLATE_NOT_FOUND" };

  if (template._count.issuedCertificates > 0 || template._count.issueRuns > 0) {
    return {
      error: `Cannot delete — ${template._count.issuedCertificates} certs issued + ${template._count.issueRuns} runs reference this template. Audit trail must stay intact.`,
      code: "TEMPLATE_HAS_HISTORY",
      issuedCount: template._count.issuedCertificates,
      runCount: template._count.issueRuns,
    };
  }

  await db.certificateTemplate.delete({ where: { id: templateId } });

  db.auditLog
    .create({
      data: {
        eventId: ctx.eventId,
        userId: ctx.userId,
        action: "DELETE",
        entityType: "CertificateTemplate",
        entityId: templateId,
        changes: { source: "mcp", name: template.name, category: template.category },
      },
    })
    .catch((err) => apiLogger.warn({ err, msg: "cert-template-mcp:audit-failed-delete" }));

  apiLogger.info({
    msg: "cert-template-mcp:deleted",
    eventId: ctx.eventId,
    userId: ctx.userId,
    templateId,
  });

  return { ok: true };
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

  const event = await db.event.findFirst({
    where: { id: ctx.eventId, organizationId: ctx.organizationId },
    select: { id: true, settings: true },
  });
  if (!event) return { error: "Event not found", code: "EVENT_NOT_FOUND" };

  const settings = readSettings(event.settings);
  const prevCme = readCme(settings);
  const nextCme = { ...prevCme };
  if (cleanedAccreditations !== undefined) nextCme.accreditations = cleanedAccreditations;
  // Strip obsolete design-approval fields — gate removed 2026-06-02.
  delete nextCme.designApprovedBy;
  delete nextCme.designApprovedAt;
  const nextSettings = { ...settings, cme: nextCme };

  await db.event.update({
    where: { id: ctx.eventId },
    data: {
      ...(cmeHoursValue !== undefined && { cmeHours: cmeHoursValue }),
      settings: nextSettings as unknown as Prisma.InputJsonValue,
    },
    select: { id: true },
  });

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
          source: "mcp",
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

const textBoxSchemaJson = {
  type: "object",
  properties: {
    id: { type: "string" },
    content: { type: "string" },
    x: { type: "number" },
    y: { type: "number" },
    width: { type: "number" },
    height: { type: "number" },
    font: {
      type: "string",
      enum: [
        "Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique",
        "Times-Roman", "Times-Bold", "Times-Italic", "Times-BoldItalic",
        "Courier", "Courier-Bold", "Courier-Oblique", "Courier-BoldOblique",
      ],
    },
    size: { type: "number" },
    color: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
    align: { type: "string", enum: ["left", "center", "right"] },
  },
  required: ["id", "content", "x", "y", "width", "height", "font", "size", "color", "align"],
} as const;

export const CERTIFICATE_TOOL_DEFINITIONS: Tool[] = [
  {
    name: "list_certificate_templates",
    description:
      "List all certificate templates for the event (both ATTENDANCE and APPRECIATION categories), plus event-level CME hours and accreditations. Each template has its own backgroundPdfUrl + textBoxes[] with {{tokens}} that resolve per recipient at issue time. v3 multi-template model (2026-06-02) — an event can have N templates per category (e.g. 'Standard Attendance', 'VIP Attendance').",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "create_certificate_template",
    description:
      "Create a new certificate template. Organizer-defined name + ATTENDANCE/APPRECIATION category. Returns the new template id. backgroundPdfUrl and textBoxes are optional at create time; the operator typically uploads the PDF + drags boxes via the dashboard canvas editor afterwards. Upload PDFs via POST /api/upload/pdf first. Optional emailSubject + emailBody define the default cover email — when set, the Issue dialog pre-fills from these; when null the dialog falls back to the per-category system default.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "Template name (e.g. 'Standard Attendance', 'VIP', 'Chairman Appreciation'). Max 120 chars.",
        },
        category: {
          type: "string",
          enum: ["ATTENDANCE", "APPRECIATION"],
          description: "Base category. ATTENDANCE pool = registrations; APPRECIATION pool = speakers + abstract submitters. Drives token availability ({{abstractTitle}} is APPRECIATION-only).",
        },
        backgroundPdfUrl: {
          type: ["string", "null"],
          description: "/uploads/... or /certificates/... path to the uploaded background PDF (optional at create).",
        },
        textBoxes: {
          type: "array",
          description: "Positioned text overlays on the cert. Max 40 per template.",
          items: textBoxSchemaJson,
        },
        emailSubject: {
          type: ["string", "null"],
          description: "Default cover-email subject. Tokens supported: {{recipientName}}, {{eventName}}, {{eventDateRange}}, {{venueLine}}, {{organizationName}}, {{certificateType}}, {{certificateSerial}}, {{abstractTitle}} (APPRECIATION only). Max 200 chars.",
        },
        emailBody: {
          type: ["string", "null"],
          description: "Default cover-email body (Tiptap HTML output). Same token set as emailSubject. Max 10000 chars. Snapshotted onto each CertificateIssueRun at Issue time so a later template edit doesn't change in-flight emails.",
        },
      },
      required: ["name", "category"],
    },
  },
  {
    name: "update_certificate_template",
    description:
      "Patch a specific template by id — change name, background PDF, text box positions, sort order, or cover-email defaults. Partial: only fields you include get updated; others preserved. Pass null for emailSubject or emailBody to clear back to the system default. Category is immutable post-create (would invalidate IssuedCertificate audit rows). Find templateIds via list_certificate_templates.",
    input_schema: {
      type: "object" as const,
      properties: {
        templateId: { type: "string", description: "ID returned by list_certificate_templates or create_certificate_template" },
        name: { type: "string", description: "Rename. Max 120 chars." },
        backgroundPdfUrl: {
          type: ["string", "null"],
          description: "/uploads/... path of the uploaded background PDF (or null to clear).",
        },
        textBoxes: {
          type: "array",
          description: "Replace the text boxes array. Max 40.",
          items: textBoxSchemaJson,
        },
        sortOrder: {
          type: "number",
          description: "Display order within the category. 0..9999.",
        },
        emailSubject: {
          type: ["string", "null"],
          description: "Default cover-email subject (max 200 chars). Null clears back to system default.",
        },
        emailBody: {
          type: ["string", "null"],
          description: "Default cover-email body in Tiptap HTML (max 10000 chars). Null clears back to system default.",
        },
      },
      required: ["templateId"],
    },
  },
  {
    name: "delete_certificate_template",
    description:
      "Delete a template by id. BLOCKED with 409-equivalent error if any IssuedCertificate or CertificateIssueRun references this template — audit trail must stay intact. Renaming the template is the alternative (mark as retired in the name).",
    input_schema: {
      type: "object" as const,
      properties: {
        templateId: { type: "string", description: "ID of the template to delete" },
      },
      required: ["templateId"],
    },
  },
  {
    name: "update_cme_settings",
    description:
      "Patch event-level CME hours and accrediting bodies. Rendered into cert templates via {{cmeHours}} / {{accreditationBody}} / {{accreditationReference}} tokens. Independent of template editing.",
    input_schema: {
      type: "object" as const,
      properties: {
        cmeHours: { type: ["number", "null"], description: "Total CME / CPD hours awarded (0..999.9) or null to clear" },
        accreditations: {
          type: "array",
          description: "Accrediting bodies. Max 5.",
          items: {
            type: "object",
            properties: {
              body: { type: "string", enum: ["DHA", "DOH", "SCFHS", "EACCME", "ACCME", "OTHER"] },
              reference: { type: "string", description: "Accreditation reference number" },
              hours: { type: "number", description: "Per-accreditor hour override (defaults to cmeHours)" },
              officialStatement: { type: "string", description: "Verbatim wording override (max 500 chars)" },
            },
            required: ["body", "reference"],
          },
        },
      },
      required: [],
    },
  },
];

export const CERTIFICATE_EXECUTORS: Record<string, ToolExecutor> = {
  list_certificate_templates: listCertificateTemplates,
  create_certificate_template: createCertificateTemplate,
  update_certificate_template: updateCertificateTemplate,
  delete_certificate_template: deleteCertificateTemplate,
  update_cme_settings: updateCmeSettings,
};
