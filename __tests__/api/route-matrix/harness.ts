/**
 * Safety net 2: the route status matrix (docs/CUSTOM_ROLES_PLAN.md Phase 1
 * slice 4, §7.5). Imported by the per-domain `*.test.ts` files beside it.
 *
 * WHY. `system-roles-parity.test.ts` proves `can()` agrees with every
 * predicate; it cannot prove a ROUTE asks for the right key. A route that
 * combined two predicates (`dtcm-pool`: desk allow-list AND barcode roles) and
 * is swept to one key would let a role through, and every other test would
 * still pass. So, per handler, this records what each caller actually gets:
 * the eight staff roles, the platform operator, the three external roles, an
 * API key and no session, against four fixture events. A domain is
 * snapshotted on the unswept code; the sweep must leave the snapshot byte for
 * byte unchanged.
 *
 * WHAT A CELL RECORDS, and why not the raw `where`. The event lookup's `where`
 * is EVALUATED against the fixture events (`matchesEvent`), so the matrix
 * records which events a caller reaches, not the shape of the filter that got
 * them there. The sweep replaces `buildEventAccessWhere` with `eventWhereFor`,
 * which may spell a filter differently and mean the same thing; a raw-shape
 * snapshot would fail on that and teach people to re-record it. An unknown
 * filter key THROWS, so a new shape is taught to the evaluator, never ignored.
 *
 * A cell is `<status>` plus markers: `r` an event read matched (the handler
 * reached data), `w` a write was attempted. Writes throw by design, so a
 * handler that gets as far as writing ends in its own catch (usually 500);
 * the `w` is what matters. The database answers nothing else: every other read
 * is empty, which is deterministic and the same before and after a sweep.
 */
import { appendFileSync } from "node:fs";
import { vi } from "vitest";

/**
 * Debugging a new domain: `MATRIX_DEBUG=/path/to/file npx vitest run __tests__/api/route-matrix`
 * appends every error a handler logs, and every throw past its own catch, to
 * that file. The console is filtered in this suite, hence a file.
 */
function debugLine(line: string): void {
  if (process.env.MATRIX_DEBUG) appendFileSync(process.env.MATRIX_DEBUG, `${line.slice(0, 600)}\n`);
}
const brief = (err: unknown) => (err instanceof Error ? (err.stack ?? err.message).split("\n").slice(0, 3).join(" | ") : String(err));

// ── Fixture world ───────────────────────────────────────────────────────────

export const ORG = "org1";
export const OTHER_ORG = "org2";

const U = {
  superAdmin: "u-super",
  operator: "u-operator",
  admin: "u-admin",
  organizer: "u-organizer",
  member: "u-member",
  onsite: "u-onsite",
  webinars: "u-webinars",
  crm: "u-crm",
  hr: "u-hr",
  reviewer: "u-reviewer",
  submitter: "u-submitter",
  registrant: "u-registrant",
} as const;

interface FixtureEvent {
  id: string;
  organizationId: string;
  eventType: "CONFERENCE" | "WEBINAR";
  slug: string;
  settings: { onsiteUserIds?: string[]; reviewerUserIds?: string[] };
  speakerUserIds: string[];
  registrantUserIds: string[];
}

/**
 * Four events, each separating callers a real route must separate:
 * - `conf`     a conference nobody is assigned to;
 * - `assigned` a conference with every per-event link (ONSITE and WEBINARS on
 *              the desk list, a reviewer, a submitter's speaker row, a
 *              registrant's registration);
 * - `webinar`  a webinar;
 * - `foreign`  another organisation's conference carrying the same links,
 *              so an org-independent role legitimately reaches it and an
 *              org-bound one must not.
 */
const links = {
  settings: { onsiteUserIds: [U.onsite, U.webinars], reviewerUserIds: [U.reviewer] },
  speakerUserIds: [U.submitter],
  registrantUserIds: [U.registrant],
};
export const EVENTS: readonly FixtureEvent[] = [
  { id: "conf", organizationId: ORG, eventType: "CONFERENCE", slug: "conf", settings: {}, speakerUserIds: [], registrantUserIds: [] },
  { id: "assigned", organizationId: ORG, eventType: "CONFERENCE", slug: "assigned", ...links },
  { id: "webinar", organizationId: ORG, eventType: "WEBINAR", slug: "webinar", settings: {}, speakerUserIds: [], registrantUserIds: [] },
  { id: "foreign", organizationId: OTHER_ORG, eventType: "CONFERENCE", slug: "foreign", ...links },
];
export const EVENT_IDS = EVENTS.map((e) => e.id);

// ── The `where` evaluator ───────────────────────────────────────────────────

type Where = Record<string, unknown>;

function matchesScalar(cond: unknown, value: string): boolean {
  if (typeof cond === "string") return cond === value;
  if (cond && typeof cond === "object" && Array.isArray((cond as { in?: unknown }).in)) {
    return ((cond as { in: string[] }).in).includes(value);
  }
  throw new Error(`route-matrix: unsupported scalar filter ${JSON.stringify(cond)}`);
}

function matchesSome(cond: unknown, userIds: string[], label: string): boolean {
  const some = (cond as { some?: { userId?: string } })?.some;
  if (!some || typeof some.userId !== "string" || Object.keys(some).length !== 1) {
    throw new Error(`route-matrix: unsupported ${label} filter ${JSON.stringify(cond)}`);
  }
  return userIds.includes(some.userId);
}

/** Does `where` admit `ev`? Throws on any key it does not understand. */
export function matchesEvent(where: Where | undefined, ev: FixtureEvent): boolean {
  if (!where) return true;
  for (const [key, cond] of Object.entries(where)) {
    if (cond === undefined) continue;
    switch (key) {
      case "id":
      case "organizationId":
      case "eventType":
      case "slug": {
        if (!matchesScalar(cond, ev[key])) return false;
        break;
      }
      case "code": {
        if (!matchesScalar(cond, ev.id.toUpperCase())) return false;
        break;
      }
      case "settings": {
        const c = cond as { path?: string[]; array_contains?: string };
        if (!Array.isArray(c.path) || c.path.length !== 1 || typeof c.array_contains !== "string") {
          throw new Error(`route-matrix: unsupported settings filter ${JSON.stringify(cond)}`);
        }
        const list = ev.settings[c.path[0] as keyof FixtureEvent["settings"]] ?? [];
        if (!list.includes(c.array_contains)) return false;
        break;
      }
      case "speakers":
        if (!matchesSome(cond, ev.speakerUserIds, "speakers")) return false;
        break;
      case "registrations":
        if (!matchesSome(cond, ev.registrantUserIds, "registrations")) return false;
        break;
      case "OR":
        if (!(cond as Where[]).some((w) => matchesEvent(w, ev))) return false;
        break;
      case "AND":
        if (!(cond as Where[]).every((w) => matchesEvent(w, ev))) return false;
        break;
      default:
        throw new Error(`route-matrix: unsupported event filter key "${key}" in ${JSON.stringify(where)}`);
    }
  }
  return true;
}

// ── The database ────────────────────────────────────────────────────────────

const WRITE_METHODS = new Set(["create", "createMany", "createManyAndReturn", "update", "updateMany", "upsert", "delete", "deleteMany"]);

interface Recording {
  eventReadMatched: boolean;
  /** Another table's read carried an `event: { … }` filter that matched a fixture event. */
  nestedEventMatched: boolean;
  wrote: boolean;
  listedEventIds: string[] | null;
}
let rec: Recording = { eventReadMatched: false, nestedEventMatched: false, wrote: false, listedEventIds: null };

function eventRow(ev: FixtureEvent) {
  return {
    id: ev.id,
    organizationId: ev.organizationId,
    eventType: ev.eventType,
    slug: ev.slug,
    name: `Event ${ev.id}`,
    status: "DRAFT",
    settings: ev.settings,
    startDate: new Date("2027-01-10T00:00:00Z"),
    endDate: new Date("2027-01-11T00:00:00Z"),
    timezone: "Asia/Dubai",
    taxRate: null,
    code: ev.id.toUpperCase(),
  };
}

function eventModel(method: string, args: { where?: Where } | undefined): unknown {
  const hits = EVENTS.filter((ev) => matchesEvent(args?.where, ev));
  if (method === "findMany") {
    rec.listedEventIds = hits.map((e) => e.id);
    if (hits.length > 0) rec.eventReadMatched = true;
    return hits.map(eventRow);
  }
  if (method === "count") return hits.length;
  if (hits.length > 0) rec.eventReadMatched = true;
  return hits[0] ? eventRow(hits[0]) : null;
}

function emptyRead(method: string): unknown {
  if (method === "findMany" || method === "groupBy") return [];
  if (method === "count") return 0;
  if (method === "aggregate") return { _sum: {}, _count: {}, _max: {}, _min: {}, _avg: {} };
  return null;
}

/**
 * A route can scope through a RELATION instead of reading the event first
 * (`abstractTheme.findFirst({ where: { id, eventId, event: { organizationId } } })`).
 * That filter is evaluated too, with the row's `eventId` as the event id, so
 * the matrix pins the scope of those lookups (`e` in a cell). The row itself
 * still reads as absent.
 */
function noteNestedEventFilter(where: Where | undefined): void {
  const nested = where?.event;
  if (!nested || typeof nested !== "object") return;
  const filter = { ...(nested as Where), ...(typeof where?.eventId === "string" ? { id: where.eventId } : {}) };
  if (EVENTS.some((ev) => matchesEvent(filter, ev))) rec.nestedEventMatched = true;
}

// ── Opt-in rows ─────────────────────────────────────────────────────────────
//
// By default every non-event read is empty, which pins who reaches an event.
// Routes whose real rules come AFTER the event (an author may edit only their
// own abstract, a reviewer scores only one assigned to them) need rows to get
// that far. A test file opts in with `useFixtureRows()`; the files that did
// not opt in keep their recorded matrices.
//
// The rows exist on every fixture event, all owned by the SUBMITTER caller's
// speaker row, and match a lookup only when its id, event, owner and author
// filters agree. Other filter keys are ignored, which is fine for a snapshot
// that compares the same queries before and after a sweep.

const SUBMITTER_ID = "u-submitter";
const REVIEWER_ID = "u-reviewer";
let fixtureRowsOn = false;
export function useFixtureRows(on = true): void {
  fixtureRowsOn = on;
}

type Row = Record<string, unknown>;
const speakerRow = (eventId: string): Row => ({
  id: "sp1", eventId, userId: SUBMITTER_ID, email: "submitter@test.local", firstName: "Sam", lastName: "Submitter", status: "CONFIRMED", tags: [],
  submitterSource: "ABSTRACT", _count: { abstracts: 1, sessionProposals: 1 },
});
const ROW_FACTORIES: Record<string, (eventId: string) => Row> = {
  speaker: speakerRow,
  abstract: (eventId) => ({
    id: "ab1", eventId, speakerId: "sp1", speaker: speakerRow(eventId), title: "A study", content: "Body", status: "SUBMITTED",
    presentationType: "ORAL", version: 0, updatedAt: new Date("2027-01-01T00:00:00Z"), createdAt: new Date("2027-01-01T00:00:00Z"),
    themeId: null, subThemeId: null, trackId: null, coAuthors: [], reviewSubmissions: [], reviewers: [], submissions: [],
    _count: { reviewers: 1, submissions: 0 },
  }),
  sessionProposal: (eventId) => ({
    id: "pr1", eventId, speakerId: "sp1", speaker: speakerRow(eventId), title: "A workshop", description: "Body", status: "SUBMITTED",
    version: 0, updatedAt: new Date("2027-01-01T00:00:00Z"), createdAt: new Date("2027-01-01T00:00:00Z"), themeId: null,
  }),
  abstractReviewer: (eventId) => ({ abstractId: "ab1", userId: REVIEWER_ID, eventId, role: "PRIMARY", conflictFlag: false }),
};

function rowMatches(row: Row, where: Where | undefined): boolean {
  if (!where) return true;
  if (typeof where.id === "string" && where.id !== row.id) return false;
  if (typeof where.eventId === "string" && where.eventId !== row.eventId) return false;
  if (typeof where.userId === "string" && where.userId !== row.userId) return false;
  if (typeof where.speakerId === "string" && where.speakerId !== row.speakerId) return false;
  const sp = where.speaker as { userId?: unknown } | undefined;
  if (sp && typeof sp.userId === "string" && sp.userId !== (row.speaker as Row | undefined)?.userId) return false;
  const pair = where.abstractId_userId as { abstractId?: string; userId?: string } | undefined;
  if (pair && (pair.abstractId !== row.abstractId || pair.userId !== row.userId)) return false;
  if (where.event && typeof where.event === "object") {
    const ev = EVENTS.find((e) => e.id === row.eventId);
    if (!ev || !matchesEvent({ ...(where.event as Where), id: row.eventId as string }, ev)) return false;
  }
  return true;
}

function fixtureRead(name: string, method: string, where: Where | undefined): { hit: true; value: unknown } | null {
  const make = ROW_FACTORIES[name];
  if (name === "user" && (method === "findUnique" || method === "findFirst") && typeof where?.id === "string") {
    const caller = CALLERS.find((c) => c.session?.user.id === where.id);
    return { hit: true, value: caller?.session ? { ...caller.session.user, email: `${where.id}@test.local` } : null };
  }
  if (!make) return null;
  const rows = EVENTS.map((e) => make(e.id)).filter((r) => rowMatches(r, where));
  if (method === "findMany") return { hit: true, value: rows };
  if (method === "count") return { hit: true, value: rows.length };
  if (method === "findFirst" || method === "findUnique" || method === "findFirstOrThrow" || method === "findUniqueOrThrow") return { hit: true, value: rows[0] ?? null };
  return null;
}

function model(name: string) {
  return new Proxy(
    {},
    {
      get(_t, method: string) {
        return async (args?: { where?: Where }) => {
          if (WRITE_METHODS.has(method)) {
            // A write can carry its own event scope (`updateMany({ where: { id,
            // event: { ... } } })`, the H-2 shape), so it is evaluated too.
            noteNestedEventFilter(args?.where);
            rec.wrote = true;
            throw new Error(`route-matrix: write ${name}.${method}`);
          }
          if (name === "event") return eventModel(method, args);
          noteNestedEventFilter(args?.where);
          if (fixtureRowsOn) {
            const hit = fixtureRead(name, method, args?.where);
            if (hit) return hit.value;
          }
          return emptyRead(method);
        };
      },
    },
  );
}

const models = new Map<string, unknown>();
export const matrixDb: Record<string, unknown> = new Proxy(
  {},
  {
    get(_t, key: string) {
      if (key === "then") return undefined;
      if (key === "$transaction") {
        return async (arg: unknown) =>
          typeof arg === "function" ? (arg as (tx: unknown) => unknown)(matrixDb) : Promise.all(arg as Promise<unknown>[]);
      }
      if (key.startsWith("$")) return async () => [];
      if (!models.has(key)) models.set(key, model(key));
      return models.get(key);
    },
  },
);

/** The `@/lib/db` module as the routes see it. */
export const dbModule = {
  db: matrixDb,
  dbOperator: matrixDb,
  tenantTransaction: (fn: (tx: unknown) => Promise<unknown>) => fn(matrixDb),
  classifyPrismaError: () => ({ kind: "unknown" }),
  resolveAuditOrganizationId: async () => ORG,
};

const noop = () => {};
const logError = (...args: unknown[]) => {
  debugLine(`logged: ${JSON.stringify(args, (_k, v) => (v instanceof Error ? brief(v) : v))}`);
};
const noopLogger = { info: noop, warn: noop, error: logError, debug: noop, trace: noop, fatal: noop, child: () => noopLogger };
/** The `@/lib/logger` module: every export a silent logger. */
export const loggerModule = {
  default: noopLogger,
  logger: noopLogger,
  apiLogger: noopLogger,
  authLogger: noopLogger,
  dbLogger: noopLogger,
  eventLogger: noopLogger,
  createLogger: () => noopLogger,
  logApiRequest: noop,
  logApiError: noop,
  logDbOperation: noop,
  logAuthEvent: noop,
};

// ── Callers ─────────────────────────────────────────────────────────────────

export const API_KEY = "matrix-api-key";

export interface Caller {
  label: string;
  session: { user: Record<string, unknown> } | null;
  apiKey?: boolean;
}

const staff = (label: string, role: string, id: string, organizationId: string | null = ORG): Caller => ({
  label,
  session: { user: { id, role, organizationId, firstName: "F", lastName: "L" } },
});

export const CALLERS: readonly Caller[] = [
  staff("SUPER_ADMIN", "SUPER_ADMIN", U.superAdmin),
  staff("OPERATOR", "SUPER_ADMIN", U.operator, null),
  staff("ADMIN", "ADMIN", U.admin),
  staff("ORGANIZER", "ORGANIZER", U.organizer),
  staff("MEMBER", "MEMBER", U.member),
  staff("ONSITE", "ONSITE", U.onsite),
  staff("WEBINARS", "WEBINARS", U.webinars),
  staff("CRM_USER", "CRM_USER", U.crm),
  staff("HR_USER", "HR_USER", U.hr),
  staff("REVIEWER", "REVIEWER", U.reviewer, null),
  staff("SUBMITTER", "SUBMITTER", U.submitter, null),
  staff("REGISTRANT", "REGISTRANT", U.registrant, null),
  { label: "API_KEY", session: null, apiKey: true },
  { label: "NONE", session: null },
];

let currentSession: Caller["session"] = null;
/** The `@/lib/auth` module's `auth()`. */
export const mockAuth = vi.fn(async () => currentSession);
/** The `@/lib/api-key` module's `validateApiKey()`: the one key the harness issues. */
export const mockValidateApiKey = vi.fn(async (raw: string) => (raw === API_KEY ? { organizationId: ORG, id: "key1", name: "matrix" } : null));

// ── Running a handler ───────────────────────────────────────────────────────

// `ctx: never` accepts every route signature (parameters are contravariant); the call site casts.
type Handler = (req: Request, ctx: never) => Promise<Response | { status: number; json: () => Promise<unknown> }>;

export interface HandlerCase {
  /** `METHOD path`, the row label. */
  name: string;
  handler: Handler;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Params other than `eventId`, which the matrix supplies. */
  params?: Record<string, string>;
  body?: unknown;
  /** Appended to the URL, e.g. `confirm=true`. */
  query?: string;
  /**
   * Sent as multipart form data instead of `body`, so an upload route gets
   * past its form parsing to the event lookup. A value with `content` is a
   * file. Without this a JSON body fails at `req.formData()` for every role,
   * and the cells cannot show which events a caller reaches.
   */
  form?: Record<string, string | { name: string; type: string; content: string }>;
  /** false for a handler with no event in its path (the events list and create). */
  perEvent?: boolean;
}

async function runOnce(c: HandlerCase, caller: Caller, eventId?: string): Promise<string> {
  currentSession = caller.session;
  rec = { eventReadMatched: false, nestedEventMatched: false, wrote: false, listedEventIds: null };
  const headers: Record<string, string> = c.form ? {} : { "content-type": "application/json" };
  if (caller.apiKey) headers.authorization = `Bearer ${API_KEY}`;
  let body: BodyInit | undefined = c.body !== undefined ? JSON.stringify(c.body) : undefined;
  if (c.form) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(c.form)) {
      fd.append(k, typeof v === "string" ? v : new File([v.content], v.name, { type: v.type }));
    }
    body = fd;
  }
  const req = new Request(`http://localhost/api/matrix${c.query ? `?${c.query}` : ""}`, {
    method: c.method,
    headers,
    ...(body !== undefined && { body }),
  });
  const params = Promise.resolve({ ...(c.params ?? {}), ...(eventId ? { eventId } : {}) });
  let status: number;
  try {
    status = (await c.handler(req, { params } as never)).status;
  } catch (err) {
    debugLine(`${c.name} ${caller.label}: ${brief(err)}`);
    status = 0; // the handler threw past its own catch
  }
  if (rec.listedEventIds) return `${status} [${rec.listedEventIds.join(",")}]`;
  return `${status}${rec.eventReadMatched ? " r" : ""}${rec.nestedEventMatched ? " e" : ""}${rec.wrote ? " w" : ""}`;
}

/** The matrix for one handler as fixed-width text, one caller per line. */
export async function matrixFor(c: HandlerCase): Promise<string> {
  const perEvent = c.perEvent !== false;
  const cols = perEvent ? EVENT_IDS : ["-"];
  const lines = [`${c.name}`, `  ${"caller".padEnd(12)}${cols.map((x) => x.padEnd(12)).join("")}`.trimEnd()];
  for (const caller of CALLERS) {
    const cells: string[] = [];
    for (const id of cols) cells.push(await runOnce(c, caller, perEvent ? id : undefined));
    lines.push(`  ${caller.label.padEnd(12)}${cells.map((x) => x.padEnd(12)).join("")}`.trimEnd());
  }
  return lines.join("\n");
}

/** The whole domain, ready for `toMatchFileSnapshot`. */
export async function domainMatrix(title: string, cases: readonly HandlerCase[]): Promise<string> {
  const blocks: string[] = [];
  for (const c of cases) blocks.push(await matrixFor(c));
  const legend =
    "# cell: HTTP status; r = an event read matched (data reached); e = another table's event filter matched; w = a write was attempted (writes throw, so the status after w is the handler's catch)\n" +
    "# events: conf (no links) · assigned (ONSITE+WEBINARS desk list, reviewer, submitter, registrant) · webinar · foreign (other org, same links)";
  return `# ${title}\n${legend}\n\n${blocks.join("\n\n")}\n`;
}
