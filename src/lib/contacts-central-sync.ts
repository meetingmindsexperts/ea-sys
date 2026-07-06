/**
 * Outbound sync of EA-SYS contacts → an external Supabase "central contacts"
 * table (`contacts_centralv1`, keyed by email), for a different project.
 *
 * Source of truth = the EA-SYS `Contact` store (which `syncToContact` keeps
 * populated from registrants, speakers, submitters, and reviewers — see
 * src/lib/contact-sync.ts), enriched with per-event arrays.
 *
 * Merge semantics (enforced ATOMICALLY by the `ea_upsert_contacts` Postgres
 * function on the TARGET — see docs/CONTACTS_CENTRAL_SYNC.md):
 *   - arrays (tags, events_attended, registration_type, event_speciality,
 *     event_type, event_group) → UNION with whatever is already there (add,
 *     never remove) so other sources' entries survive.
 *   - scalars → ENRICH-only (fill a blank; never overwrite an existing value).
 *   - `evenstair_customerid`, `created_at`, `fetched_at`, and every `mailchimp_*`
 *     column are NEVER written by us (not in the payload) — fully preserved.
 *
 * Residency note: the target project is EU (eu-north-1); attendee PII leaves
 * the Mumbai boundary. This is an explicit, signed-off data-sharing decision.
 */
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { formatAttendeeRole } from "@/lib/schemas";
import type { AttendeeRole } from "@prisma/client";

const isEnabled = () => process.env.CONTACTS_CENTRAL_ENABLED === "true";
const baseUrl = () => (process.env.CONTACTS_CENTRAL_URL || "").replace(/\/+$/, "");
const serviceKey = () => process.env.CONTACTS_CENTRAL_SERVICE_KEY || "";
const RPC = "ea_upsert_contacts";
const BATCH_SIZE = 500;

export function isCentralSyncConfigured(): boolean {
  return isEnabled() && !!baseUrl() && !!serviceKey();
}

/** The exact payload we send — ONLY EA-SYS-owned columns. */
export interface CentralContactRow {
  email: string;
  first_name: string | null;
  last_name: string | null;
  organization_name: string | null;
  job_title: string | null;
  mobile: string | null;
  city: string | null;
  country: string | null;
  speciality: string | null;
  role: string | null;
  tags: string[];
  events_attended: string[];
  registration_type: string[];
  event_speciality: string[];
  event_type: string[];
  event_group: string[];
  last_updated: string; // ISO
}

export interface ContactForSync {
  email: string;
  firstName: string;
  lastName: string;
  organization: string | null;
  jobTitle: string | null;
  phone: string | null;
  city: string | null;
  country: string | null;
  specialty: string | null;
  customSpecialty: string | null;
  role: AttendeeRole | null;
  tags: string[];
  eventIds: string[];
  registrationType: string | null;
}

export interface EventMeta {
  name: string;
  specialty: string | null;
  eventType: string | null;
  tag: string | null;
}

function uniq(xs: (string | null | undefined)[]): string[] {
  return [...new Set(xs.filter((x): x is string => typeof x === "string" && x.trim() !== ""))];
}

/**
 * Pure mapper — Contact (+ resolved event metadata + the person's registration
 * types) → the central-table row. Exported for tests.
 */
export function buildCentralRow(
  c: ContactForSync,
  eventMeta: Map<string, EventMeta>,
  regTypesByEmail: Map<string, string[]>,
  nowIso: string,
): CentralContactRow {
  const email = c.email.toLowerCase().trim();
  const events = c.eventIds.map((id) => eventMeta.get(id)).filter((e): e is EventMeta => !!e);
  const speciality = c.specialty === "Others" && c.customSpecialty ? c.customSpecialty : c.specialty;

  return {
    email,
    first_name: c.firstName || null,
    last_name: c.lastName || null,
    organization_name: c.organization || null,
    job_title: c.jobTitle || null,
    mobile: c.phone || null,
    city: c.city || null,
    country: c.country || null,
    speciality: speciality || null,
    role: c.role ? formatAttendeeRole(c.role) : null,
    tags: uniq(c.tags),
    events_attended: uniq(events.map((e) => e.name)),
    registration_type: uniq([...(regTypesByEmail.get(email) ?? []), c.registrationType ?? ""]),
    event_speciality: uniq(events.map((e) => e.specialty)),
    event_type: uniq(events.map((e) => e.eventType)),
    event_group: uniq(events.map((e) => e.tag)),
    last_updated: nowIso,
  };
}

/**
 * Build the rows to sync. `since` scopes to contacts touched since then
 * (incremental worker); omit it for a full reconcile (backfill).
 */
export async function buildCentralRows(opts: { since?: Date } = {}): Promise<CentralContactRow[]> {
  const contacts = await db.contact.findMany({
    where: opts.since ? { updatedAt: { gte: opts.since } } : {},
    select: {
      email: true, firstName: true, lastName: true, organization: true, jobTitle: true,
      phone: true, city: true, country: true, specialty: true, customSpecialty: true,
      role: true, tags: true, eventIds: true, registrationType: true,
    },
  });
  if (contacts.length === 0) return [];

  const eventIds = uniq(contacts.flatMap((c) => c.eventIds));
  const [events, regs] = await Promise.all([
    eventIds.length
      ? db.event.findMany({
          where: { id: { in: eventIds } },
          select: { id: true, name: true, specialty: true, eventType: true, tag: true },
        })
      : Promise.resolve([]),
    // Registration types per person. A light 2-column read; scoped by email in
    // memory (Prisma `in` is case-sensitive, emails vary in case).
    db.registration.findMany({
      select: { attendee: { select: { email: true } }, ticketType: { select: { name: true } } },
    }),
  ]);

  const eventMeta = new Map<string, EventMeta>(
    events.map((e) => [e.id, { name: e.name, specialty: e.specialty, eventType: e.eventType, tag: e.tag }]),
  );
  const regTypesByEmail = new Map<string, string[]>();
  for (const r of regs) {
    const e = r.attendee?.email?.toLowerCase().trim();
    const t = r.ticketType?.name;
    if (!e || !t) continue;
    const arr = regTypesByEmail.get(e) ?? [];
    if (!arr.includes(t)) arr.push(t);
    regTypesByEmail.set(e, arr);
  }

  const nowIso = new Date().toISOString();
  // Dedup by lowercased email (single-org today; a guard for safety).
  const byEmail = new Map<string, CentralContactRow>();
  for (const c of contacts) {
    const row = buildCentralRow(c, eventMeta, regTypesByEmail, nowIso);
    byEmail.set(row.email, row);
  }
  return [...byEmail.values()];
}

/** Call the target's `ea_upsert_contacts` RPC in batches (atomic union+enrich). */
export async function upsertCentralRows(rows: CentralContactRow[]): Promise<{ sent: number; failed: number }> {
  if (!isCentralSyncConfigured()) {
    apiLogger.warn({ msg: "contacts-central:not-configured" });
    return { sent: 0, failed: 0 };
  }
  const endpoint = `${baseUrl()}/rest/v1/rpc/${RPC}`;
  const key = serviceKey();
  let sent = 0;
  let failed = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify({ p_rows: batch }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        apiLogger.error({
          msg: "contacts-central:rpc-failed",
          status: res.status,
          body: body.slice(0, 500),
          batch: batch.length,
        });
        failed += batch.length;
      } else {
        sent += batch.length;
      }
    } catch (err) {
      apiLogger.error({ err, msg: "contacts-central:rpc-error", batch: batch.length });
      failed += batch.length;
    }
  }
  return { sent, failed };
}

/**
 * Incremental worker tick — sync contacts touched in the last `lookbackMinutes`
 * (default 30). Idempotent (the RPC's union/enrich makes re-sends safe), so the
 * generous overlap vs the ~10-min cadence is harmless.
 */
export async function runContactsCentralTick(opts: { lookbackMinutes?: number } = {}): Promise<{ synced: number; failed: number }> {
  if (!isCentralSyncConfigured()) return { synced: 0, failed: 0 };
  const lookback = opts.lookbackMinutes ?? 30;
  const since = new Date(Date.now() - lookback * 60 * 1000);
  const rows = await buildCentralRows({ since });
  if (rows.length === 0) return { synced: 0, failed: 0 };
  const { sent, failed } = await upsertCentralRows(rows);
  apiLogger.info({ msg: "contacts-central:tick", candidates: rows.length, sent, failed, lookbackMinutes: lookback });
  return { synced: sent, failed };
}
