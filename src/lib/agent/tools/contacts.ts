import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { normalizeTag } from "@/lib/utils";
import { EMAIL_RE, TITLE_VALUES, type ToolExecutor } from "./_shared";

const listContacts: ToolExecutor = async (input, ctx) => {
  try {
    const limit = Math.min(Number(input.limit ?? 50), 200);
    const search = input.search ? String(input.search).trim() : undefined;
    const tag = input.tag ? String(input.tag).trim() : undefined;

    const contacts = await db.contact.findMany({
      where: {
        organizationId: ctx.organizationId,
        ...(tag ? { tags: { has: tag } } : {}),
        ...(search ? {
          OR: [
            { firstName: { contains: search, mode: "insensitive" as const } },
            { lastName: { contains: search, mode: "insensitive" as const } },
            { email: { contains: search, mode: "insensitive" as const } },
          ],
        } : {}),
      },
      select: {
        id: true, email: true, firstName: true, lastName: true, organization: true,
        jobTitle: true, city: true, country: true, tags: true,
      },
      take: limit,
      orderBy: { lastName: "asc" },
    });
    return { contacts, total: contacts.length };
  } catch (err) {
    apiLogger.error({ err }, "agent:list_contacts failed");
    return { error: "Failed to fetch contacts" };
  }
};

const createContact: ToolExecutor = async (input, ctx) => {
  try {
    const email = String(input.email ?? "").trim().toLowerCase();
    const firstName = String(input.firstName ?? "").trim();
    const lastName = String(input.lastName ?? "").trim();
    if (!email || !firstName || !lastName) return { error: "email, firstName, and lastName are required" };
    if (!EMAIL_RE.test(email)) return { error: "Invalid email format" };

    const existing = await db.contact.findFirst({
      where: { organizationId: ctx.organizationId, email },
      select: { id: true, email: true, firstName: true, lastName: true },
    });
    if (existing) {
      return {
        alreadyExists: true,
        existingId: existing.id,
        contact: existing,
        message: `A contact with email ${email} already exists in this organization`,
      };
    }

    const contact = await db.contact.create({
      data: {
        organizationId: ctx.organizationId,
        email,
        firstName,
        lastName,
        organization: input.organization ? String(input.organization) : null,
        jobTitle: input.jobTitle ? String(input.jobTitle) : null,
        phone: input.phone ? String(input.phone) : null,
        city: input.city ? String(input.city) : null,
        country: input.country ? String(input.country) : null,
        tags: Array.isArray(input.tags) ? (input.tags as string[]) : [],
      },
      select: { id: true, email: true, firstName: true, lastName: true },
    });
    return { contact };
  } catch (err) {
    apiLogger.error({ err }, "agent:create_contact failed");
    return { error: "Failed to create contact" };
  }
};

// ─── Reviewer Executor ────────────────────────────────────────────────────────

const updateContact: ToolExecutor = async (input, ctx) => {
  try {
    const contactId = String(input.contactId ?? "").trim();
    if (!contactId) return { error: "contactId is required", code: "MISSING_CONTACT_ID" };

    const existing = await db.contact.findFirst({
      where: { id: contactId, organizationId: ctx.organizationId },
      select: { id: true, email: true, firstName: true, lastName: true },
    });
    if (!existing) return { error: `Contact ${contactId} not found or access denied`, code: "CONTACT_NOT_FOUND" };

    const updates: Prisma.ContactUpdateInput = {};

    if (input.firstName != null) updates.firstName = String(input.firstName).slice(0, 100);
    if (input.lastName != null) updates.lastName = String(input.lastName).slice(0, 100);

    if (input.title != null) {
      const t = String(input.title);
      if (t === "") updates.title = null;
      else if (TITLE_VALUES.has(t)) updates.title = t as never;
      else return { error: `Invalid title`, code: "INVALID_TITLE" };
    }
    if (input.organization != null) updates.organization = String(input.organization).slice(0, 255);
    if (input.jobTitle != null) updates.jobTitle = String(input.jobTitle).slice(0, 255);
    if (input.bio != null) updates.bio = String(input.bio).slice(0, 5000);
    if (input.specialty != null) updates.specialty = String(input.specialty).slice(0, 255);
    if (input.phone != null) updates.phone = String(input.phone).slice(0, 50);
    if (input.photo !== undefined) updates.photo = input.photo as string | null;
    if (input.city != null) updates.city = String(input.city).slice(0, 255);
    if (input.state != null) updates.state = String(input.state).slice(0, 255);
    if (input.zipCode != null) updates.zipCode = String(input.zipCode).slice(0, 50);
    if (input.country != null) updates.country = String(input.country).slice(0, 255);
    if (input.notes != null) updates.notes = String(input.notes).slice(0, 10000);
    if (Array.isArray(input.tags)) {
      updates.tags = (input.tags as unknown[])
        .map((t) => normalizeTag(String(t).slice(0, 100)))
        .filter(Boolean);
    }
    // Email updates go through a separate flow (dedup / merge) — keep immutable here.
    if (input.email != null) {
      return {
        error: "email cannot be updated via this tool — use the dashboard contact merge flow",
        code: "EMAIL_IMMUTABLE",
      };
    }

    if (Object.keys(updates).length === 0) {
      return { error: "No fields provided to update", code: "NO_FIELDS" };
    }

    const updated = await db.contact.update({
      where: { id: contactId },
      data: updates,
      select: {
        id: true,
        title: true,
        firstName: true,
        lastName: true,
        email: true,
        organization: true,
        jobTitle: true,
        phone: true,
        city: true,
        country: true,
        tags: true,
      },
    });

    db.auditLog.create({
      data: {
        // Contacts are org-scoped, not event-scoped; we don't have an eventId
        // to attribute to. Skip the eventId field (audit log is org-wide).
        userId: ctx.userId,
        action: "UPDATE",
        entityType: "Contact",
        entityId: contactId,
        changes: { source: "mcp", fieldsChanged: Object.keys(updates) },
      },
    }).catch((err) => apiLogger.error({ err }, "agent:update_contact audit-log-failed"));

    return { success: true, contact: updated };
  } catch (err) {
    apiLogger.error({ err }, "agent:update_contact failed");
    return { error: err instanceof Error ? err.message : "Failed to update contact" };
  }
};

// Safe fields for update_event — everything in this set can be changed without
// breaking public URLs, email scheduling, Zoom provisioning, or timezone math.
// slug + startDate + endDate + eventType + timezone are intentionally excluded
// because they cascade to registered URLs, scheduled-email fire times, webinar

export const CONTACT_TOOL_DEFINITIONS: Tool[] = [
  {
    name: "list_contacts",
    description: "List contacts in the organization. Optionally filter by tag or search.",
    input_schema: {
      type: "object" as const,
      properties: {
        search: { type: "string", description: "Search by name or email" },
        tag: { type: "string", description: "Filter by tag" },
        limit: { type: "number", description: "Max results (default 50, max 200)" },
      },
      required: [],
    },
  },
  {
    name: "create_contact",
    description: "Create a new contact in the organization.",
    input_schema: {
      type: "object" as const,
      properties: {
        email: { type: "string" },
        firstName: { type: "string" },
        lastName: { type: "string" },
        organization: { type: "string" },
        jobTitle: { type: "string" },
        phone: { type: "string" },
        city: { type: "string" },
        country: { type: "string" },
        tags: { type: "array", items: { type: "string" }, description: "Tags to assign" },
      },
      required: ["email", "firstName", "lastName"],
    },
  },
];

export const CONTACT_EXECUTORS: Record<string, ToolExecutor> = {
  list_contacts: listContacts,
  create_contact: createContact,
  update_contact: updateContact,
};
