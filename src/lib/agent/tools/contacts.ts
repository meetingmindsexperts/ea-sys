import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { normalizeTag } from "@/lib/utils";
import { EMAIL_RE, TITLE_VALUES, type ToolExecutor } from "./_shared";

/** Above this many results a bio is cut to a preview, so a broad search stays readable. */
const FULL_BIO_UP_TO = 10;
const BIO_PREVIEW = 200;

/**
 * Each word of the search must match the first name, last name, email or
 * organisation (Nov 18, 2026). The whole text against each column found no
 * one for "Mahmoud Marashi", which is neither a first nor a last name, and the
 * agent told the organiser the person was not in the contacts.
 */
function contactSearchWhere(search: string): Prisma.ContactWhereInput[] {
  return search
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6)
    .map((word) => ({
      OR: [
        { firstName: { contains: word, mode: "insensitive" as const } },
        { lastName: { contains: word, mode: "insensitive" as const } },
        { email: { contains: word, mode: "insensitive" as const } },
        { organization: { contains: word, mode: "insensitive" as const } },
      ],
    }));
}

/**
 * Every person field a contact holds, with its id (Nov 18, 2026): the
 * agent's list used to show a name, an address and the organisation, so it
 * could neither import a contact nor copy its job title, country or specialty,
 * and it reported those as missing from the contact.
 */
const listContacts: ToolExecutor = async (input, ctx) => {
  try {
    // Tenancy pilot: ALS tenant scope (no-op while RLS_SET_LOCAL is off).
    return await runWithTenant(ctx.organizationId, async () => {
    const limit = Math.min(Math.max(Number(input.limit ?? 50) || 50, 1), 200);
    const search = input.search ? String(input.search).trim().slice(0, 200) : undefined;
    const tag = input.tag ? String(input.tag).trim() : undefined;

    const contacts = await db.contact.findMany({
      where: {
        organizationId: ctx.organizationId,
        ...(tag ? { tags: { has: tag } } : {}),
        ...(search ? { AND: contactSearchWhere(search) } : {}),
      },
      select: {
        id: true, title: true, email: true, additionalEmail: true, firstName: true, lastName: true,
        organization: true, jobTitle: true, role: true, specialty: true, customSpecialty: true,
        phone: true, photo: true, city: true, state: true, zipCode: true, country: true, bio: true, tags: true,
      },
      take: limit,
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    });
    const fullBio = contacts.length <= FULL_BIO_UP_TO;
    return {
      contacts: contacts.map((c) => {
        if (fullBio || !c.bio || c.bio.length <= BIO_PREVIEW) return c;
        return { ...c, bio: `${c.bio.slice(0, BIO_PREVIEW)}…`, bioTruncated: true };
      }),
      total: contacts.length,
      ...(fullBio ? {} : { note: `Bios are cut to ${BIO_PREVIEW} characters above ${FULL_BIO_UP_TO} results; search more narrowly for the full text.` }),
    };
    });
  } catch (err) {
    apiLogger.error({ err }, "agent:list_contacts failed");
    return { error: "Failed to fetch contacts" };
  }
};

const createContact: ToolExecutor = async (input, ctx) => {
  try {
    // Tenancy pilot: ALS tenant scope (no-op while RLS_SET_LOCAL is off).
    return await runWithTenant(ctx.organizationId, async () => {
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
    });
  } catch (err) {
    apiLogger.error({ err }, "agent:create_contact failed");
    return { error: "Failed to create contact" };
  }
};

// ─── Reviewer Executor ────────────────────────────────────────────────────────

const updateContact: ToolExecutor = async (input, ctx) => {
  try {
    // Tenancy pilot: ALS tenant scope (no-op while RLS_SET_LOCAL is off).
    return await runWithTenant(ctx.organizationId, async () => {
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
      where: { id: contactId, organizationId: ctx.organizationId },
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
        changes: { source: ctx.source, fieldsChanged: Object.keys(updates) },
      },
    }).catch((err) => apiLogger.error({ err }, "agent:update_contact audit-log-failed"));

    return { success: true, contact: updated };
    });
  } catch (err) {
    apiLogger.error({ err }, "agent:update_contact failed");
    return { error: err instanceof Error ? err.message : "Failed to update contact" };
  }
};

// Safe fields for update_event — everything in this set can be changed without
// breaking public URLs, email scheduling, Zoom provisioning, or timezone math.
// slug + startDate + endDate + eventType + timezone are intentionally excluded
// because they cascade to registered URLs, scheduled-email fire times, webinar

export const CONTACT_EXECUTORS: Record<string, ToolExecutor> = {
  list_contacts: listContacts,
  create_contact: createContact,
  update_contact: updateContact,
};
