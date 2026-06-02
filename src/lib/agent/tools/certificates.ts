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

const CERT_TYPES = ["ATTENDANCE", "PRESENTER", "POSTER", "CME"] as const;
type CertTypeKey = (typeof CERT_TYPES)[number];

const ACCREDITOR_BODIES = ["DHA", "DOH", "SCFHS", "EACCME", "ACCME", "OTHER"] as const;

interface Signature {
  image?: string | null;
  name: string;
  lines: string[];
}
interface FooterLogo {
  label?: string;
  image: string;
}
interface Template {
  headerImage?: string | null;
  titleText?: string;
  titleColor?: string;
  bodyTemplate?: string;
  signatures?: Signature[];
  footerLogos?: FooterLogo[];
  footerText?: string;
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
  // Backward compat: legacy single template seeds all 4 slots.
  const legacy = settings.certificateTemplate;
  if (legacy && typeof legacy === "object" && !Array.isArray(legacy)) {
    const seed = legacy as Template;
    return { ATTENDANCE: seed, PRESENTER: seed, POSTER: seed, CME: seed };
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
  };
}

// ── Tool: update_certificate_template ───────────────────────────────────────

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const LOCAL_URL_RE = /^\/(uploads|certificates)\//;

function validateAssetUrl(url: unknown, field: string): string | { error: string; code: string } {
  if (typeof url !== "string" || url.length === 0) {
    return { error: `${field} must be a non-empty string`, code: "INVALID_ASSET_URL" };
  }
  if (!LOCAL_URL_RE.test(url) || url.length > 500) {
    return {
      error: `${field} must be a /uploads/... or /certificates/... path (max 500 chars). Upload the asset first via the media library to get a usable URL.`,
      code: "INVALID_ASSET_URL",
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

  // Validate every field that's present in the patch. Each is optional —
  // a caller can update just the headerImage without touching the rest.
  const patch: Template = {};
  if (input.headerImage !== undefined) {
    if (input.headerImage === null) {
      patch.headerImage = null;
    } else {
      const v = validateAssetUrl(input.headerImage, "headerImage");
      if (typeof v !== "string") return v;
      patch.headerImage = v;
    }
  }
  if (input.titleText !== undefined) {
    if (typeof input.titleText !== "string" || input.titleText.length > 120) {
      return { error: "titleText must be string (max 120 chars)", code: "INVALID_FIELD" };
    }
    patch.titleText = input.titleText;
  }
  if (input.titleColor !== undefined) {
    if (typeof input.titleColor !== "string" || !HEX_COLOR_RE.test(input.titleColor)) {
      return { error: "titleColor must be a 6-digit hex color e.g. #1a2e5a", code: "INVALID_FIELD" };
    }
    patch.titleColor = input.titleColor;
  }
  if (input.bodyTemplate !== undefined) {
    if (typeof input.bodyTemplate !== "string" || input.bodyTemplate.length > 4000) {
      return { error: "bodyTemplate must be string (max 4000 chars; HTML output of Tiptap editor)", code: "INVALID_FIELD" };
    }
    patch.bodyTemplate = input.bodyTemplate;
  }
  if (input.footerText !== undefined) {
    if (typeof input.footerText !== "string" || input.footerText.length > 800) {
      return { error: "footerText must be string (max 800 chars; HTML)", code: "INVALID_FIELD" };
    }
    patch.footerText = input.footerText;
  }
  if (input.signatures !== undefined) {
    if (!Array.isArray(input.signatures) || input.signatures.length > 4) {
      return { error: "signatures must be array (max 4 entries)", code: "INVALID_FIELD" };
    }
    const out: Signature[] = [];
    for (const [i, raw] of input.signatures.entries()) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return { error: `signatures[${i}] must be an object`, code: "INVALID_FIELD" };
      }
      const sig = raw as Record<string, unknown>;
      if (typeof sig.name !== "string" || sig.name.trim().length === 0) {
        return { error: `signatures[${i}].name is required`, code: "INVALID_FIELD" };
      }
      const sigOut: Signature = { name: sig.name.trim(), lines: [] };
      if (sig.image !== undefined) {
        if (sig.image === null) {
          sigOut.image = null;
        } else {
          const v = validateAssetUrl(sig.image, `signatures[${i}].image`);
          if (typeof v !== "string") return v;
          sigOut.image = v;
        }
      }
      if (sig.lines !== undefined) {
        if (!Array.isArray(sig.lines) || sig.lines.length > 6) {
          return { error: `signatures[${i}].lines must be array (max 6)`, code: "INVALID_FIELD" };
        }
        sigOut.lines = sig.lines.map((l) => String(l).slice(0, 200));
      }
      out.push(sigOut);
    }
    patch.signatures = out;
  }
  if (input.footerLogos !== undefined) {
    if (!Array.isArray(input.footerLogos) || input.footerLogos.length > 6) {
      return { error: "footerLogos must be array (max 6 entries)", code: "INVALID_FIELD" };
    }
    const out: FooterLogo[] = [];
    for (const [i, raw] of input.footerLogos.entries()) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return { error: `footerLogos[${i}] must be an object`, code: "INVALID_FIELD" };
      }
      const logo = raw as Record<string, unknown>;
      const v = validateAssetUrl(logo.image, `footerLogos[${i}].image`);
      if (typeof v !== "string") return v;
      const logoOut: FooterLogo = { image: v };
      if (logo.label !== undefined && logo.label !== null) {
        if (typeof logo.label !== "string" || logo.label.length > 60) {
          return { error: `footerLogos[${i}].label must be string (max 60)`, code: "INVALID_FIELD" };
        }
        logoOut.label = logo.label;
      }
      out.push(logoOut);
    }
    patch.footerLogos = out;
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
      headerImage: nextTemplate.headerImage ?? null,
      titleText: nextTemplate.titleText ?? null,
      titleColor: nextTemplate.titleColor ?? null,
      bodyTemplate: nextTemplate.bodyTemplate ?? null,
      signatures: nextTemplate.signatures ?? [],
      footerLogos: nextTemplate.footerLogos ?? [],
      footerText: nextTemplate.footerText ?? null,
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
      "Read all 4 certificate templates (Attendance / Presenter / Poster / CME) for the event, plus event-level CME hours, accreditations, and design-approval state. Templates live in Event.settings.certificateTemplates; this is the canonical read path.",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "update_certificate_template",
    description:
      "Patch one cert type's template (banner image URL, title text + color, body HTML, signatures, footer logos, footer text). Asset URLs (headerImage, signatures[].image, footerLogos[].image) must be /uploads/... paths — upload via the media library first, then pass the returned URL. Partial patch — only fields you include get updated; existing fields you omit are preserved.",
    input_schema: {
      type: "object" as const,
      properties: {
        type: {
          type: "string",
          enum: ["ATTENDANCE", "PRESENTER", "POSTER", "CME"],
          description: "Which cert type's template to update",
        },
        headerImage: { type: ["string", "null"], description: "/uploads/... path of the banner image (or null to clear)" },
        titleText: { type: "string", description: "Title heading text (e.g. 'Certificate of Attendance'). Max 120 chars." },
        titleColor: { type: "string", description: "Title color as 6-digit hex (e.g. #1a2e5a)", pattern: "^#[0-9a-fA-F]{6}$" },
        bodyTemplate: {
          type: "string",
          description: "Body HTML with {{token}} placeholders. Supported tokens: recipientName, eventName, eventDateRange, venueLine, accreditationBody, accreditationReference, cmeHours. Max 4000 chars.",
        },
        signatures: {
          type: "array",
          description: "Signature blocks (chairman, co-chairmen). Max 4.",
          items: {
            type: "object",
            properties: {
              image: { type: ["string", "null"], description: "/uploads/... path of signature PNG" },
              name: { type: "string", description: "Display name e.g. 'DR. AHMAD AL-RIFAI'" },
              lines: { type: "array", items: { type: "string" }, description: "Lines below name (title, institution, country)" },
            },
            required: ["name"],
          },
        },
        footerLogos: {
          type: "array",
          description: "Society logos at the bottom. Max 6.",
          items: {
            type: "object",
            properties: {
              image: { type: "string", description: "/uploads/... path of the logo" },
              label: { type: "string", description: "Optional label e.g. 'Hosted by'" },
            },
            required: ["image"],
          },
        },
        footerText: { type: "string", description: "Plain or HTML text below footer logos. Max 800 chars." },
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
