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
const tableName = () => process.env.CONTACTS_CENTRAL_TABLE || "contacts_centralv1";
// Read-modify-write chunk size — smaller than a bulk upsert because each chunk
// GETs the existing rows (emails go in the URL) then POSTs the merged batch.
const CHUNK_SIZE = 100;

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

/** The merged payload we actually send — enriched scalars + unioned arrays. */
export interface CentralPayload {
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
  source: string;
  /** Provenance marker — set true on every row EA-SYS touches. */
  ea_synced: boolean;
  last_updated: string;
  tags: string[];
  events_attended: string[];
  registration_type: string[];
  event_speciality: string[];
  event_type: string[];
  event_group: string[];
}

function nz(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}
function unionArr(existing: unknown, ours: string[]): string[] {
  const prev = Array.isArray(existing) ? existing.map((x) => String(x)) : [];
  return [...new Set([...prev, ...ours].map((s) => s.trim()).filter((s) => s !== ""))];
}

/**
 * Merge our computed view with the row already in the central table: scalars
 * ENRICH (keep an existing non-empty value; else fill from us), arrays UNION
 * (add ours, never drop theirs). Pure — exported for tests. `existing` is the
 * (partial) PostgREST row, or undefined for a brand-new email.
 */
export function mergeWithExisting(ours: CentralContactRow, existing?: Record<string, unknown>): CentralPayload {
  const e = existing ?? {};
  return {
    email: ours.email,
    first_name: nz(e.first_name) ?? ours.first_name,
    last_name: nz(e.last_name) ?? ours.last_name,
    organization_name: nz(e.organization_name) ?? ours.organization_name,
    job_title: nz(e.job_title) ?? ours.job_title,
    mobile: nz(e.mobile) ?? ours.mobile,
    city: nz(e.city) ?? ours.city,
    country: nz(e.country) ?? ours.country,
    speciality: nz(e.speciality) ?? ours.speciality,
    role: nz(e.role) ?? ours.role,
    source: nz(e.source) ?? "ea-sys",
    ea_synced: true,
    last_updated: ours.last_updated,
    tags: unionArr(e.tags, ours.tags),
    events_attended: unionArr(e.events_attended, ours.events_attended),
    registration_type: unionArr(e.registration_type, ours.registration_type),
    event_speciality: unionArr(e.event_speciality, ours.event_speciality),
    event_type: unionArr(e.event_type, ours.event_type),
    event_group: unionArr(e.event_group, ours.event_group),
  };
}

const SELECT_COLS =
  "email,first_name,last_name,organization_name,job_title,mobile,city,country," +
  "speciality,role,source,tags,events_attended,registration_type,event_speciality,event_type,event_group";

/**
 * Upsert entirely from OUR side — no functions in the target project. Per chunk:
 * GET the existing rows → merge (union arrays, enrich scalars) in our code →
 * POST an upsert (merge-duplicates) of only our columns, so
 * evenstair_customerid / created_at / fetched_at / mailchimp_* are left
 * untouched (preserved by omission).
 *
 * Trade-off vs a server-side RPC: read-then-write is NOT atomic — if ANOTHER
 * source writes the same columns in the tiny window between our GET and POST,
 * that write can be lost. Our own sync is single-writer (advisory lock), so the
 * only race is cross-source; acceptable for a periodic mirror.
 */
export async function upsertCentralRows(rows: CentralContactRow[]): Promise<{ sent: number; failed: number }> {
  if (!isCentralSyncConfigured()) {
    apiLogger.warn({ msg: "contacts-central:not-configured" });
    return { sent: 0, failed: 0 };
  }
  const base = baseUrl();
  const key = serviceKey();
  const table = tableName();
  const readHeaders = { apikey: key, Authorization: `Bearer ${key}` };
  const writeHeaders = {
    ...readHeaders,
    "Content-Type": "application/json",
    Prefer: "resolution=merge-duplicates,return=minimal",
  };
  let sent = 0;
  let failed = 0;

  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    try {
      // 1. Fetch existing rows for this chunk's emails.
      const inList = chunk.map((r) => `"${r.email.replace(/["\\]/g, "")}"`).join(",");
      const getUrl = `${base}/rest/v1/${table}?select=${SELECT_COLS}&email=in.(${encodeURIComponent(inList)})`;
      const getRes = await fetch(getUrl, { headers: readHeaders });
      if (!getRes.ok) {
        const body = await getRes.text().catch(() => "");
        apiLogger.error({ msg: "contacts-central:read-failed", status: getRes.status, body: body.slice(0, 400), chunk: chunk.length });
        failed += chunk.length;
        continue;
      }
      const existingRows = (await getRes.json()) as Record<string, unknown>[];
      const existingByEmail = new Map<string, Record<string, unknown>>(
        existingRows.map((row) => [String(row.email ?? "").toLowerCase(), row]),
      );

      // 2. Merge (union arrays, enrich scalars).
      const payload = chunk.map((r) => mergeWithExisting(r, existingByEmail.get(r.email)));

      // 3. Upsert only our columns; foreign-managed columns preserved by omission.
      const postRes = await fetch(`${base}/rest/v1/${table}?on_conflict=email`, {
        method: "POST",
        headers: writeHeaders,
        body: JSON.stringify(payload),
      });
      if (!postRes.ok) {
        const body = await postRes.text().catch(() => "");
        apiLogger.error({ msg: "contacts-central:upsert-failed", status: postRes.status, body: body.slice(0, 400), chunk: chunk.length });
        failed += chunk.length;
      } else {
        sent += chunk.length;
      }
    } catch (err) {
      apiLogger.error({ err, msg: "contacts-central:upsert-error", chunk: chunk.length });
      failed += chunk.length;
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
