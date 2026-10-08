/**
 * Event service: the one way to create an event.
 *
 *   createEvent() — REST POST /api/events, the agent / MCP `create_event`
 *                   tool, and (next) an approved Event Blueprint.
 *
 * Before this existed the two callers had drifted: the REST route seeded the
 * starting registration types and email templates but wrote no audit row and
 * suffixed a clashing slug with a timestamp; the agent tool wrote an audit row
 * but seeded nothing and suffixed `-1`, `-2`. Every caller now gets all of it.
 * The starting registration types are the ORGANISATION's list (Settings →
 * General), never a hard-coded one: this is a multi-tenant system.
 *
 * Clone (`/events/[id]/clone`) and the EventsAir import are deliberately NOT
 * here: they copy an existing event's configuration rather than starting from
 * the defaults, which is different mechanics (services/README.md, the bulk
 * exception).
 *
 * Authorisation (who may create, the webinar-only grant) stays with the
 * caller; the service trusts its already-validated input.
 */

import { Prisma, type Event, type EventStatus, type EventType } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { runWithTenant } from "@/lib/tenant-context";
import { slugify, deriveEventCode } from "@/lib/utils";
import { resolveUniqueEventCode } from "@/lib/event-code";
import { refreshEventStats } from "@/lib/event-stats";
import { DEFAULT_TEMPLATES } from "@/lib/email";
import { readDefaultRegistrationTypes } from "@/lib/default-registration-types";
import { DEFAULT_TIER_NAMES } from "@/lib/presenter-tiers";
import { DEFAULT_REGISTRATION_TERMS_HTML, DEFAULT_SPEAKER_AGREEMENT_HTML } from "@/lib/default-terms";
import { provisionWebinar } from "@/lib/webinar-provisioner";

// ── Input / Result types ─────────────────────────────────────────────────────

export interface CreateEventInput {
  organizationId: string;
  userId: string;

  name: string;
  startDate: Date;
  endDate: Date;

  description?: string | null;
  eventType?: EventType | null;
  status?: EventStatus;
  /** Requested slug; slugified. Defaults to the slugified name. */
  slug?: string | null;
  /** Explicit invoice code, already trimmed + uppercased by the caller. */
  code?: string | null;
  timezone?: string | null;
  venue?: string | null;
  address?: string | null;
  city?: string | null;
  country?: string | null;
  tag?: string | null;
  specialty?: string | null;
  requiresDtcmBarcode?: boolean;

  source: "rest" | "mcp" | "agent" | "api" | "blueprint";
}

export type CreateEventErrorCode =
  | "INVALID_SLUG"
  | "INVALID_DATE_RANGE"
  | "SLUG_TAKEN"
  | "EVENT_CODE_TAKEN";

export type CreateEventResult =
  | { ok: true; event: Event }
  | { ok: false; code: CreateEventErrorCode; message: string; meta?: Record<string, unknown> };

/** How many `-n` suffixes to try before giving up on a slug. */
const SLUG_SUFFIX_ATTEMPTS = 10;

/** Inserts tried when a concurrent create wins a unique index (P2002). */
const CREATE_ATTEMPTS = 3;

// ── Service ──────────────────────────────────────────────────────────────────

export function createEvent(input: CreateEventInput): Promise<CreateEventResult> {
  return runWithTenant(input.organizationId, () => createEventInTenant(input));
}

async function createEventInTenant(input: CreateEventInput): Promise<CreateEventResult> {
  if (input.endDate < input.startDate) {
    return fail("INVALID_DATE_RANGE", "endDate must be on or after startDate", input);
  }

  const baseSlug = resolveBaseSlug(input);
  if (!baseSlug) return fail("INVALID_SLUG", "The requested web address has no usable characters (a-z, 0-9)", input);

  // The slug and code checks are reads, so two creates of the same name can
  // both pass them; the unique indexes catch the loser (P2002), which then
  // re-resolves against the winner's row and tries again.
  for (let attempt = 1; ; attempt++) {
    try {
      return await insertEvent(input, baseSlug);
    } catch (err) {
      if (!isUniqueViolation(err) || attempt >= CREATE_ATTEMPTS) throw err;
      apiLogger.warn({ msg: "event-service:unique-race-retry", attempt, organizationId: input.organizationId, source: input.source });
    }
  }
}

/**
 * The web address to start from. A requested slug that slugifies to nothing is
 * the caller's error; a NAME that does (Arabic only, say: `slugify` keeps a-z
 * and 0-9) falls back to `event-<random>`, so the name never blocks the create.
 */
function resolveBaseSlug(input: CreateEventInput): string | null {
  const requested = input.slug?.trim();
  if (requested) return slugify(requested) || null;
  return slugify(input.name) || `event-${Math.random().toString(36).slice(2, 7)}`;
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

async function insertEvent(input: CreateEventInput, baseSlug: string): Promise<CreateEventResult> {
  const { organizationId, userId, name, startDate, endDate, source } = input;

  const slug = await findFreeSlug(organizationId, baseSlug);
  if (!slug) {
    return fail(
      "SLUG_TAKEN",
      `The web address "${baseSlug}" is taken; tried ${SLUG_SUFFIX_ATTEMPTS} suffixes. Choose another.`,
      input,
      { slug: baseSlug },
    );
  }

  // Event.code is the invoice-number prefix and the QuickBooks Class label,
  // unique per organisation. An explicit code that is taken is refused; a
  // DERIVED one that is taken is dropped to null (owner: no invented suffixes),
  // and the organiser sets one in Settings.
  const explicitCode = input.code?.trim().toUpperCase() || null;
  const resolvedCode = await resolveUniqueEventCode({
    organizationId,
    explicitCode,
    derivedCode: explicitCode ? null : deriveEventCode(name),
  });
  if (!resolvedCode.ok) {
    return fail(
      "EVENT_CODE_TAKEN",
      `Event code ${explicitCode} is already used by another event in this organisation`,
      input,
      { code: explicitCode },
    );
  }
  if (resolvedCode.derivedCollision) {
    apiLogger.warn({
      msg: "event-service:code-derivation-collision",
      organizationId,
      source,
      derivedCode: resolvedCode.derivedCollision,
      hint: "Set the event code in Settings before creating a budget or issuing an invoice.",
    });
  }

  const event = await db.event.create({
    data: {
      organizationId,
      name,
      slug,
      code: resolvedCode.code,
      description: input.description || null,
      startDate,
      endDate,
      ...(input.timezone && { timezone: input.timezone }),
      venue: input.venue || null,
      address: input.address || null,
      city: input.city || null,
      country: input.country || null,
      eventType: input.eventType ?? null,
      tag: input.tag || null,
      specialty: input.specialty || null,
      requiresDtcmBarcode: input.requiresDtcmBarcode === true,
      status: input.status ?? "DRAFT",
      registrationTermsHtml: DEFAULT_REGISTRATION_TERMS_HTML,
      speakerAgreementHtml: DEFAULT_SPEAKER_AGREEMENT_HTML,
    },
  });

  apiLogger.info({ msg: "event-service:created", eventId: event.id, organizationId, source, eventType: event.eventType });

  // Everything below is best-effort: the event exists, and each step logs its
  // own failure rather than undoing the create.
  seedDefaults(event);
  writeAudit(event, userId, source);
  refreshEventStats(event.id);
  if (event.eventType === "WEBINAR") {
    provisionWebinar(event.id, { actorUserId: userId }).catch((err) =>
      apiLogger.error({ err, eventId: event.id, source, msg: "event-service:webinar-provision-failed" }),
    );
  }

  return { ok: true, event };
}

async function findFreeSlug(organizationId: string, baseSlug: string): Promise<string | null> {
  for (let i = 0; i <= SLUG_SUFFIX_ATTEMPTS; i++) {
    const candidate = i === 0 ? baseSlug : `${baseSlug}-${i}`;
    const existing = await db.event.findFirst({
      where: { organizationId, slug: candidate },
      select: { id: true },
    });
    if (!existing) return candidate;
  }
  return null;
}

/**
 * Default email templates, and the organisation's own starting registration
 * types (Settings → General; none when it has no list), each with the
 * DEFAULT_TIER_NAMES pricing tiers, inactive. The Email Templates page also
 * backfills missing templates on first open, so a failed template seed
 * self-heals; registration types do not.
 */
function seedDefaults(event: Event): void {
  db.emailTemplate
    .createMany({
      data: DEFAULT_TEMPLATES.map((t) => ({
        eventId: event.id,
        slug: t.slug,
        name: t.name,
        subject: t.subject,
        htmlContent: t.htmlContent,
        textContent: t.textContent,
      })),
      skipDuplicates: true,
    })
    .catch((err) => apiLogger.error({ err, eventId: event.id, msg: "event-service:seed-templates-failed" }));

  seedRegistrationTypes(event).catch((err) =>
    apiLogger.error({ err, eventId: event.id, msg: "event-service:seed-registration-types-failed" }),
  );
}

async function seedRegistrationTypes(event: Event): Promise<void> {
  const org = await db.organization.findUnique({
    where: { id: event.organizationId },
    select: { settings: true },
  });
  const names = readDefaultRegistrationTypes(org?.settings);
  if (names.length === 0) {
    apiLogger.info({ msg: "event-service:no-default-registration-types", eventId: event.id });
    return;
  }

  await Promise.all(
    names.map((name, sortOrder) =>
      db.ticketType.create({
        data: {
          eventId: event.id,
          organizationId: event.organizationId,
          name,
          isDefault: true,
          isActive: true,
          sortOrder,
          pricingTiers: {
            create: DEFAULT_TIER_NAMES.map((tierName, i) => ({
              organizationId: event.organizationId,
              name: tierName,
              price: 0,
              currency: "USD",
              isActive: false,
              sortOrder: i,
            })),
          },
        },
      }),
    ),
  );
}

function writeAudit(event: Event, userId: string, source: CreateEventInput["source"]): void {
  db.auditLog
    .create({
      data: {
        eventId: event.id,
        userId,
        action: "CREATE",
        entityType: "Event",
        entityId: event.id,
        changes: {
          source,
          name: event.name,
          slug: event.slug,
          code: event.code,
          eventType: event.eventType ?? null,
        },
      },
    })
    .catch((err) => apiLogger.error({ err, eventId: event.id, msg: "event-service:audit-log-failed" }));
}

function fail(
  code: CreateEventErrorCode,
  message: string,
  input: CreateEventInput,
  meta?: Record<string, unknown>,
): CreateEventResult {
  apiLogger.warn({ msg: "event-service:create-refused", code, organizationId: input.organizationId, source: input.source, ...meta });
  return { ok: false, code, message, ...(meta && { meta }) };
}
