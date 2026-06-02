/**
 * MCP / agent tools for certificate template management.
 *
 * Per-event certificate templates live in `Event.settings.certificateTemplates`
 * (JSONB on the existing Event row, no separate table). Each of the four
 * CertificateType values has its own complete template — banner image URL,
 * title text + color, body HTML (with {{tokens}}), signatures array,
 * footer logos array, footer text.
 *
 * Tools exposed:
 *   - list_certificate_templates    GET  all 4 + CME settings (read-only)
 *   - update_certificate_template   PATCH one type's template
 *   - update_cme_settings           PATCH event-level CME hours + accreditations
 *
 * Asset URLs (headerImage / signatures[].image / footerLogos[].image)
 * MUST be `/uploads/...` paths — the cert renderer's `loadLocalAsset()`
 * helper rejects external URLs (avoids fetch + adds a failure mode in
 * PDF generation). The MCP caller is responsible for first uploading
 * the asset via the existing media library / photo-upload endpoint and
 * then passing the returned URL here.
 */

import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import type { AgentContext, ToolExecutor } from "./_shared";

// 2-type model (2026-06-02). PRESENTER + POSTER + CME collapsed into
// APPRECIATION; CME hours + accreditations stay on the event row and
// render via {{cmeHours}} / {{accreditationBody}} tokens on either
// cert type.
const CERT_TYPES = ["ATTENDANCE", "APPRECIATION"] as const;
type CertTypeKey = (typeof CERT_TYPES)[number];

const ACCREDITOR_BODIES = ["DHA", "DOH", "SCFHS", "EACCME", "ACCME", "OTHER"] as const;

// v3 PDF-overlay template shape (2026-06-02). The MCP tool surface
// reflects the storage shape: organizer uploads a finished cert PDF
// and positions text boxes (with {{tokens}}) on top. Legacy v2 fields
// (headerImage / titleText / signatures / etc.) are gone from the
// type so the MCP `list_certificate_templates` response is in lock-
// step with the dashboard.
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
interface Template {
  backgroundPdfUrl?: string | null;
  textBoxes?: TextBox[];
}

// ── Settings JSON readers ───────────────────────────────────────────────────

function readSettings(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw as Record<string, unknown>;
}

function readTemplates(settings: Record<string, unknown>): Partial<Record<CertTypeKey, Template>> {
  const t = settings.certificateTemplates;
  if (t && typeof t === "object" && !Array.isArray(t)) {
    return t as Partial<Record<CertTypeKey, Template>>;
  }
  // Backward compat: legacy single template seeds both v3 slots. After
  // the 2026-06-02 collapse there are only two; the legacy visual is
  // gone but the slot's existence carries forward so the organizer
  // sees that a re-upload is needed.
  const legacy = settings.certificateTemplate;
  if (legacy && typeof legacy === "object" && !Array.isArray(legacy)) {
    const seed = legacy as Template;
    return { ATTENDANCE: seed, APPRECIATION: seed };
  }
  return {};
}

function readCme(settings: Record<string, unknown>): {
  accreditations?: Array<Record<string, unknown>>;
  designApprovedBy?: string;
  designApprovedAt?: string;
} {
  const c = settings.cme;
  if (!c || typeof c !== "object" || Array.isArray(c)) return {};
  return c as Record<string, unknown>;
}

// ── Tool: list_certificate_templates ────────────────────────────────────────

async function listCertificateTemplates(_input: Record<string, unknown>, ctx: AgentContext) {
  const event = await db.event.findFirst({
    where: { id: ctx.eventId, organizationId: ctx.organizationId },
    select: { id: true, cmeHours: true, settings: true },
  });
  if (!event) return { error: "Event not found", code: "EVENT_NOT_FOUND" };

  const settings = readSettings(event.settings);
  const templates = readTemplates(settings);
  const cme = readCme(settings);
  return {
    eventId: event.id,
    cmeHours: event.cmeHours == null ? null : Number(event.cmeHours),
    accreditations: cme.accreditations ?? [],
    designApprovedBy: cme.designApprovedBy ?? null,
    designApprovedAt: cme.designApprovedAt ?? null,
    templates: Object.fromEntries(
      CERT_TYPES.map((type) => {
        const t = templates[type] ?? {};
        return [type, {
          backgroundPdfUrl: t.backgroundPdfUrl ?? null,
          textBoxes: t.textBoxes ?? [],
        }];
      }),
    ),
  };
}

// ── Tool: update_certificate_template ───────────────────────────────────────

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const LOCAL_URL_RE = /^\/(uploads|certificates)\//;
const FONT_NAMES = new Set([
  "Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique",
  "Times-Roman", "Times-Bold", "Times-Italic", "Times-BoldItalic",
  "Courier", "Courier-Bold", "Courier-Oblique", "Courier-BoldOblique",
]);

function validatePdfUrl(url: unknown, field: string): string | { error: string; code: string } {
  if (typeof url !== "string" || url.length === 0) {
    return { error: `${field} must be a non-empty string`, code: "INVALID_PDF_URL" };
  }
  if (!LOCAL_URL_RE.test(url) || url.length > 500) {
    return {
      error: `${field} must be a /uploads/... or /certificates/... path (max 500 chars). Upload the PDF first via POST /api/upload/pdf to get a usable URL.`,
      code: "INVALID_PDF_URL",
    };
  }
  return url;
}

async function updateCertificateTemplate(input: Record<string, unknown>, ctx: AgentContext) {
  const type = input.type;
  if (typeof type !== "string" || !CERT_TYPES.includes(type as CertTypeKey)) {
    return {
      error: `type must be one of: ${CERT_TYPES.join(", ")}`,
      code: "INVALID_TYPE",
    };
  }
  const typeKey = type as CertTypeKey;

  // v3 PDF-overlay patch. Two optional fields; omitting either
  // preserves the existing value in the slot.
  const patch: Template = {};
  if (input.backgroundPdfUrl !== undefined) {
    if (input.backgroundPdfUrl === null) {
      patch.backgroundPdfUrl = null;
    } else {
      const v = validatePdfUrl(input.backgroundPdfUrl, "backgroundPdfUrl");
      if (typeof v !== "string") return v;
      patch.backgroundPdfUrl = v;
    }
  }
  if (input.textBoxes !== undefined) {
    if (!Array.isArray(input.textBoxes) || input.textBoxes.length > 40) {
      return { error: "textBoxes must be an array (max 40 entries)", code: "INVALID_FIELD" };
    }
    const out: TextBox[] = [];
    for (const [i, raw] of input.textBoxes.entries()) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return { error: `textBoxes[${i}] must be an object`, code: "INVALID_FIELD" };
      }
      const b = raw as Record<string, unknown>;
      // id + content
      if (typeof b.id !== "string" || b.id.length === 0 || b.id.length > 64) {
        return { error: `textBoxes[${i}].id must be a non-empty string (max 64 chars)`, code: "INVALID_FIELD" };
      }
      if (typeof b.content !== "string" || b.content.length > 500) {
        return { error: `textBoxes[${i}].content must be string (max 500 chars)`, code: "INVALID_FIELD" };
      }
      // x / y / width / height — pdf-lib points (1pt = 1/72")
      for (const dim of ["x", "y", "width", "height"] as const) {
        const v = b[dim];
        if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 2000) {
          return { error: `textBoxes[${i}].${dim} must be number in [0, 2000]`, code: "INVALID_FIELD" };
        }
        if ((dim === "width" || dim === "height") && v < 1) {
          return { error: `textBoxes[${i}].${dim} must be >= 1`, code: "INVALID_FIELD" };
        }
      }
      // font / size / color / align
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
    patch.textBoxes = out;
  }

  // Read-modify-write the templates map. Same merge semantics as the
  // REST PATCH route — preserve unset fields in the existing slot.
  const event = await db.event.findFirst({
    where: { id: ctx.eventId, organizationId: ctx.organizationId },
    select: { id: true, settings: true },
  });
  if (!event) return { error: "Event not found", code: "EVENT_NOT_FOUND" };

  const settings = readSettings(event.settings);
  const templates = readTemplates(settings);
  const prevTemplate = templates[typeKey] ?? {};
  const nextTemplate: Template = { ...prevTemplate, ...patch };
  const nextTemplates = { ...templates, [typeKey]: nextTemplate };
  const nextSettings = {
    ...settings,
    certificateTemplates: nextTemplates,
    certificateTemplate: undefined, // drop the legacy key when migrating
  };

  await db.event.update({
    where: { id: ctx.eventId },
    data: { settings: nextSettings as unknown as Prisma.InputJsonValue },
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
          domain: "certificate-template",
          source: "mcp",
          type: typeKey,
          fieldsChanged: Object.keys(patch),
        },
      },
    })
    .catch((err) => apiLogger.warn({ err, msg: "cert-template-mcp:audit-failed" }));

  apiLogger.info({
    msg: "cert-template-mcp:updated",
    eventId: ctx.eventId,
    userId: ctx.userId,
    type: typeKey,
    fieldsChanged: Object.keys(patch),
  });

  return {
    ok: true,
    type: typeKey,
    template: {
      backgroundPdfUrl: nextTemplate.backgroundPdfUrl ?? null,
      textBoxes: nextTemplate.textBoxes ?? [],
    },
  };
}

// ── Tool: update_cme_settings ───────────────────────────────────────────────

async function updateCmeSettings(input: Record<string, unknown>, ctx: AgentContext) {
  // cmeHours: number | null | undefined
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

  // accreditations: array | undefined
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
    cmeHours: cmeHoursValue === undefined
      ? "unchanged"
      : cmeHoursValue,
    accreditationsCount: cleanedAccreditations?.length ?? "unchanged",
  };
}

// ── Exports ─────────────────────────────────────────────────────────────────

export const CERTIFICATE_TOOL_DEFINITIONS: Tool[] = [
  {
    name: "list_certificate_templates",
    description:
      "Read both certificate templates (Attendance + Appreciation) for the event, plus event-level CME hours, accreditations, and design-approval state. Each template is the v3 PDF-overlay shape: backgroundPdfUrl (the uploaded finished cert PDF from the designer) + textBoxes[] (positioned overlays with {{tokens}}). Collapsed from 4 to 2 cert types on 2026-06-02 — APPRECIATION absorbed the old PRESENTER / POSTER / CME slots.",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "update_certificate_template",
    description:
      "Patch one cert type's template — set the background PDF and/or the array of positioned text boxes (each with content containing {{tokens}} that resolve per recipient at issue time). backgroundPdfUrl must be a /uploads/... or /certificates/... path; upload the PDF first via POST /api/upload/pdf (5MB cap, %PDF- magic-byte validated) to get a usable URL. Partial patch: omit a field to preserve it.",
    input_schema: {
      type: "object" as const,
      properties: {
        type: {
          type: "string",
          enum: ["ATTENDANCE", "APPRECIATION"],
          description: "Which cert type's template to update",
        },
        backgroundPdfUrl: {
          type: ["string", "null"],
          description: "/uploads/... path of the uploaded background PDF (or null to clear)",
        },
        textBoxes: {
          type: "array",
          description: "Positioned text overlays. Max 40 per template.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Stable id (uuid/cuid) — used as React key + update target" },
              content: {
                type: "string",
                description: "Text + {{tokens}}. Supported tokens: recipientName, eventName, eventDateRange, venueLine, accreditationBody, accreditationReference, cmeHours. Max 500 chars.",
              },
              x: { type: "number", description: "Left edge in pdf-lib points (1pt = 1/72\"), origin top-left in editor coords" },
              y: { type: "number", description: "Top edge in pdf-lib points, origin top-left in editor coords" },
              width: { type: "number", description: "Box width in points (drives alignment anchor + wrap)" },
              height: { type: "number", description: "Box height in points (vertical centering reference)" },
              font: {
                type: "string",
                enum: [
                  "Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique",
                  "Times-Roman", "Times-Bold", "Times-Italic", "Times-BoldItalic",
                  "Courier", "Courier-Bold", "Courier-Oblique", "Courier-BoldOblique",
                ],
                description: "One of pdf-lib's 14 standard fonts (12 exposed; Symbol + ZapfDingbats omitted)",
              },
              size: { type: "number", description: "Font size in points (4..120)" },
              color: { type: "string", pattern: "^#[0-9a-fA-F]{6}$", description: "6-digit hex color e.g. #1a2e5a" },
              align: { type: "string", enum: ["left", "center", "right"] },
            },
            required: ["id", "content", "x", "y", "width", "height", "font", "size", "color", "align"],
          },
        },
      },
      required: ["type"],
    },
  },
  {
    name: "update_cme_settings",
    description:
      "Patch event-level CME hours and accrediting bodies. These are shared across cert types (the {{cmeHours}}, {{accreditationBody}}, {{accreditationReference}} tokens read from here). Independent of certificate template editing.",
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
  update_certificate_template: updateCertificateTemplate,
  update_cme_settings: updateCmeSettings,
};
