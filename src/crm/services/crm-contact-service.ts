/**
 * CRM contact service — the people we negotiate WITH.
 *
 * A CrmContact is a pharma rep, an exhibitor's sales manager, a society liaison, a
 * procurement officer. NOT a doctor.
 *
 * ─── WHY THIS IS NOT THE `Contact` TABLE ──────────────────────────────────────
 * `Contact` is the EVENT contact store — HCPs. Every row in it is mirrored to the
 * external `contacts_centralv1` table by `contacts-central-sync`, which selects
 * with NO where-clause, and that table feeds `mailchimp_*`. A pharma rep in
 * `Contact` would be marketed to as though they were a doctor.
 *
 * We could have added a `contactType` discriminator and filtered every reader. We
 * didn't, because that makes the leak a MISSING FILTER rather than an IMPOSSIBLE
 * STATE — and there are several readers today (the sync, the contacts list, CSV
 * export, bulk-email audiences) plus every reader added in future. Separate tables
 * mean a rep cannot reach the HCP marketing mirror even if someone forgets. Same
 * reasoning as `nameKey` carrying the unique index instead of trusting writers to
 * lowercase.
 *
 * ─── THE PERSON WHO IS BOTH ───────────────────────────────────────────────────
 * An Abbott rep often also attends the conference. That is ONE human with two hats,
 * and EA-SYS's rule is "one person, one record" — so we do not duplicate them.
 * `linkToEventContact()` POINTS this CRM record at their event `Contact` row.
 * Linked, never copied. Same shape as `Speaker.sourceRegistrationId`.
 */
import { Prisma, type CrmContact, type CrmLifecycleStage } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { recordCrmActivity, diffFields } from "@/crm/lib/crm-activity";

/** Fields worth showing in the change log when a contact is edited. */
const CONTACT_DIFF_KEYS = ["firstName", "lastName", "email", "jobTitle", "phone", "country", "notes", "lifecycleStage", "companyId"] as const;

// ── Types ────────────────────────────────────────────────────────────────────

interface ContactFields {
  firstName: string;
  lastName: string;
  email: string;
  companyId?: string | null;
  jobTitle?: string | null;
  phone?: string | null;
  country?: string | null;
  notes?: string | null;
  lifecycleStage?: CrmLifecycleStage | null;
}

export interface CreateCrmContactInput extends ContactFields {
  organizationId: string;
  userId: string | null;
  source: "rest" | "mcp" | "api";
  requestIp?: string;
}

export interface UpdateCrmContactInput extends Partial<ContactFields> {
  crmContactId: string;
  organizationId: string;
  userId: string | null;
  source: "rest" | "mcp" | "api";
}

export type CrmContactErrorCode =
  | "EMAIL_TAKEN"
  | "NAME_REQUIRED"
  | "EMAIL_REQUIRED"
  | "CONTACT_NOT_FOUND"
  | "COMPANY_NOT_FOUND"
  | "EVENT_CONTACT_NOT_FOUND"
  | "NO_FIELDS"
  | "UNKNOWN";

type Fail = { ok: false; code: CrmContactErrorCode; message: string; meta?: Record<string, unknown> };
export type CrmContactResult = { ok: true; crmContact: CrmContact; created?: boolean } | Fail;

/**
 * The dedup key. Exported so any backfill/import derives the SAME key the runtime
 * does — a script computing its key differently from the app is how reconciliation
 * jobs end up disagreeing with the system they reconcile.
 */
export function contactEmailKey(email: string): string {
  return email.trim().toLowerCase();
}

async function assertCompany(organizationId: string, companyId?: string | null): Promise<Fail | null> {
  if (!companyId) return null;
  const c = await db.crmCompany.findFirst({
    where: { id: companyId, organizationId },
    select: { id: true },
  });
  return c ? null : { ok: false, code: "COMPANY_NOT_FOUND", message: "Company not found" };
}

// ── Create (find-or-create) ──────────────────────────────────────────────────

/**
 * Find an existing CRM contact by normalized email, else create one.
 *
 * Find-or-create rather than strict-create because you meet the same rep from two
 * directions (added on a deal, then again from a company page) and minting a second
 * row for one human is the bug this whole module exists to stop.
 */
export async function findOrCreateCrmContact(
  input: CreateCrmContactInput,
): Promise<CrmContactResult> {
  const firstName = input.firstName?.trim() ?? "";
  const lastName = input.lastName?.trim() ?? "";
  const email = input.email?.trim() ?? "";

  if (!firstName || !lastName) {
    return { ok: false, code: "NAME_REQUIRED", message: "First and last name are required" };
  }
  if (!email) {
    return { ok: false, code: "EMAIL_REQUIRED", message: "Email is required" };
  }

  const emailKey = contactEmailKey(email);

  const companyFail = await assertCompany(input.organizationId, input.companyId);
  if (companyFail) return companyFail;

  try {
    const existing = await db.crmContact.findUnique({
      where: { organizationId_emailKey: { organizationId: input.organizationId, emailKey } },
    });
    if (existing) {
      apiLogger.info({
        msg: "crm-contact:reused",
        crmContactId: existing.id,
        organizationId: input.organizationId,
        source: input.source,
      });
      return { ok: true, crmContact: existing, created: false };
    }

    const crmContact = await db.crmContact.create({
      data: {
        organizationId: input.organizationId,
        companyId: input.companyId ?? null,
        firstName,
        lastName,
        email,
        emailKey,
        jobTitle: input.jobTitle?.trim() || null,
        phone: input.phone?.trim() || null,
        country: input.country?.trim() || null,
        notes: input.notes?.trim() || null,
        lifecycleStage: input.lifecycleStage ?? null,
      },
    });

    void recordCrmActivity({
      organizationId: input.organizationId,
      entityType: "CONTACT",
      entityId: crmContact.id,
      action: "CREATE",
      actorId: input.userId,
      changes: { source: input.source, email: emailKey, companyId: crmContact.companyId },
    });

    apiLogger.info({
      msg: "crm-contact:created",
      crmContactId: crmContact.id,
      organizationId: input.organizationId,
      source: input.source,
    });
    return { ok: true, crmContact, created: true };
  } catch (err) {
    // The unique index is the real guarantee; this is the concurrent-create branch.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const winner = await db.crmContact.findUnique({
        where: { organizationId_emailKey: { organizationId: input.organizationId, emailKey } },
      });
      if (winner) {
        apiLogger.info({ msg: "crm-contact:create-race-reused", crmContactId: winner.id });
        return { ok: true, crmContact: winner, created: false };
      }
    }
    apiLogger.error({
      msg: "crm-contact:create-failed",
      organizationId: input.organizationId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, code: "UNKNOWN", message: "Could not create the contact" };
  }
}

// ── Update ───────────────────────────────────────────────────────────────────

export async function updateCrmContact(input: UpdateCrmContactInput): Promise<CrmContactResult> {
  const data: Prisma.CrmContactUpdateManyMutationInput & { companyId?: string | null } = {};

  if (input.firstName !== undefined) {
    const v = input.firstName.trim();
    if (!v) return { ok: false, code: "NAME_REQUIRED", message: "First name cannot be empty" };
    data.firstName = v;
  }
  if (input.lastName !== undefined) {
    const v = input.lastName.trim();
    if (!v) return { ok: false, code: "NAME_REQUIRED", message: "Last name cannot be empty" };
    data.lastName = v;
  }
  if (input.email !== undefined) {
    const v = input.email.trim();
    if (!v) return { ok: false, code: "EMAIL_REQUIRED", message: "Email cannot be empty" };
    data.email = v;
    // Keep the dedup key in lockstep with the display value — a rename that moved
    // one without the other would let a duplicate in through the back door.
    data.emailKey = contactEmailKey(v);
  }
  if (input.jobTitle !== undefined) data.jobTitle = input.jobTitle?.trim() || null;
  if (input.phone !== undefined) data.phone = input.phone?.trim() || null;
  if (input.country !== undefined) data.country = input.country?.trim() || null;
  if (input.notes !== undefined) data.notes = input.notes?.trim() || null;
  if (input.lifecycleStage !== undefined) data.lifecycleStage = input.lifecycleStage;
  if (input.companyId !== undefined) data.companyId = input.companyId;

  if (Object.keys(data).length === 0) {
    return { ok: false, code: "NO_FIELDS", message: "No fields to update" };
  }

  const companyFail = await assertCompany(input.organizationId, input.companyId);
  if (companyFail) return companyFail;

  try {
    const before = await db.crmContact.findFirst({
      where: { id: input.crmContactId, organizationId: input.organizationId },
      select: { firstName: true, lastName: true, email: true, jobTitle: true, phone: true, country: true, notes: true, lifecycleStage: true, companyId: true },
    });
    if (!before) {
      apiLogger.warn({
        msg: "crm-contact:update-not-found",
        crmContactId: input.crmContactId,
        organizationId: input.organizationId,
      });
      return { ok: false, code: "CONTACT_NOT_FOUND", message: "Contact not found" };
    }

    await db.crmContact.updateMany({
      where: { id: input.crmContactId, organizationId: input.organizationId },
      data,
    });

    const crmContact = await db.crmContact.findUniqueOrThrow({ where: { id: input.crmContactId } });

    // Diff BEFORE + the submitted patch — NOT the post-write re-read (CRM review
    // M4): a concurrent writer landing between our write and a re-read would have
    // ITS change recorded under THIS actor's name in the History log. The patch
    // is what this actor actually did; diff exactly that.
    const fieldChanges = diffFields(before, { ...before, ...data } as typeof before, CONTACT_DIFF_KEYS);
    void recordCrmActivity({
      organizationId: input.organizationId,
      entityType: "CONTACT",
      entityId: crmContact.id,
      action: "UPDATE",
      actorId: input.userId,
      changes: { source: input.source, ...(fieldChanges ? { changes: fieldChanges } : {}) },
    });

    apiLogger.info({ msg: "crm-contact:updated", crmContactId: crmContact.id, source: input.source });
    return { ok: true, crmContact };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      // An email collision on edit is an ordinary user action, not a server
      // fault — as UNKNOWN it surfaced as an unlogged HTTP 500 (CRM review H4).
      apiLogger.warn({ msg: "crm-contact:update-email-taken", crmContactId: input.crmContactId, organizationId: input.organizationId });
      return {
        ok: false,
        code: "EMAIL_TAKEN",
        message: "Another CRM contact already uses that email",
        meta: { conflict: "email" },
      };
    }
    apiLogger.error({
      msg: "crm-contact:update-failed",
      crmContactId: input.crmContactId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, code: "UNKNOWN", message: "Could not update the contact" };
  }
}

// ── Link to the event contact store ──────────────────────────────────────────

/**
 * Point this CRM contact at their event `Contact` row — for the rep who ALSO
 * attends the conference.
 *
 * This is a POINTER, not a copy. The two rows stay separate populations (the event
 * Contact keeps flowing to the HCP marketing mirror; the CrmContact never does),
 * but the app can now show "this rep is also registered for BRIDGES 2026".
 *
 * Pass `contactId: null` to unlink.
 */
export async function linkToEventContact(input: {
  crmContactId: string;
  contactId: string | null;
  organizationId: string;
  userId: string | null;
  source: "rest" | "mcp" | "api";
}): Promise<CrmContactResult> {
  try {
    if (input.contactId) {
      const eventContact = await db.contact.findFirst({
        where: { id: input.contactId, organizationId: input.organizationId },
        select: { id: true },
      });
      if (!eventContact) {
        apiLogger.warn({
          msg: "crm-contact:link-unknown-event-contact",
          crmContactId: input.crmContactId,
          contactId: input.contactId,
        });
        return {
          ok: false,
          code: "EVENT_CONTACT_NOT_FOUND",
          message: "That person is not in the event contact store",
        };
      }
    }

    const res = await db.crmContact.updateMany({
      where: { id: input.crmContactId, organizationId: input.organizationId },
      data: { contactId: input.contactId },
    });
    if (res.count === 0) {
      return { ok: false, code: "CONTACT_NOT_FOUND", message: "Contact not found" };
    }

    const crmContact = await db.crmContact.findUniqueOrThrow({ where: { id: input.crmContactId } });

    void recordCrmActivity({
      organizationId: input.organizationId,
      entityType: "CONTACT",
      entityId: crmContact.id,
      action: input.contactId ? "LINK_EVENT_CONTACT" : "UNLINK_EVENT_CONTACT",
      actorId: input.userId,
      changes: { source: input.source, contactId: input.contactId },
    });

    apiLogger.info({
      msg: input.contactId ? "crm-contact:linked-to-event-contact" : "crm-contact:unlinked",
      crmContactId: crmContact.id,
      contactId: input.contactId,
    });
    return { ok: true, crmContact };
  } catch (err) {
    apiLogger.error({
      msg: "crm-contact:link-failed",
      crmContactId: input.crmContactId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, code: "UNKNOWN", message: "Could not link the contact" };
  }
}

// ── Archive / restore (soft delete) ──────────────────────────────────────────

/**
 * Archive or restore a CRM contact (soft delete). Idempotent; RBAC at the route.
 * Archiving does NOT touch deal links or the event-contact pointer — a reversible
 * hide, not a cascade.
 */
export async function setCrmContactArchived(input: {
  crmContactId: string;
  organizationId: string;
  userId: string | null;
  source: "rest" | "mcp" | "api";
  archived: boolean;
}): Promise<CrmContactResult> {
  try {
    const current = await db.crmContact.findFirst({
      where: { id: input.crmContactId, organizationId: input.organizationId },
    });
    if (!current) {
      apiLogger.warn({ msg: "crm-contact:archive-not-found", crmContactId: input.crmContactId, organizationId: input.organizationId });
      return { ok: false, code: "CONTACT_NOT_FOUND", message: "Contact not found" };
    }

    const alreadyInState = input.archived ? current.archivedAt !== null : current.archivedAt === null;
    if (alreadyInState) return { ok: true, crmContact: current };

    const crmContact = await db.crmContact.update({
      where: { id: current.id },
      data: { archivedAt: input.archived ? new Date() : null },
    });

    void recordCrmActivity({
      organizationId: input.organizationId,
      entityType: "CONTACT",
      entityId: crmContact.id,
      action: input.archived ? "ARCHIVE" : "RESTORE",
      actorId: input.userId,
      changes: { source: input.source, name: `${crmContact.firstName} ${crmContact.lastName}`.trim(), email: crmContact.emailKey },
    });

    apiLogger.info({
      msg: input.archived ? "crm-contact:archived" : "crm-contact:restored",
      crmContactId: crmContact.id,
      source: input.source,
    });
    return { ok: true, crmContact };
  } catch (err) {
    apiLogger.error({
      msg: "crm-contact:archive-failed",
      crmContactId: input.crmContactId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, code: "UNKNOWN", message: "Could not archive the contact" };
  }
}
