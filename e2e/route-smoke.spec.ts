/**
 * Route smoke test (Nov 17, 2026): every GET route handler, found on disk, is
 * asked on a real database as each of the five seeded roles and signed out.
 * None may answer with a server error.
 *
 * WHY. A rename by pattern changed `loadEvent(gate.eventWhere)` to
 * `loadEvent(gate)` in the desk Walk-in QR route, whose own `loadEvent` took a
 * parameter typed `object`. It compiled, every unit test passed (they mock the
 * database), and the route would have answered 500 to every request. A
 * reviewer caught it; nothing mechanical could. The class is "the code type
 * checks and the mocked tests pass, but the query Prisma is handed is wrong",
 * and the only thing that sees it is a real request on a real database.
 *
 * WHAT IT IS NOT. It does not check that an answer is CORRECT, only that the
 * server did not fall over: a 200, a 400 for a missing query parameter, a 403
 * and a 404 all pass. Writes (POST, PUT, DELETE) are not asked: they change
 * rows, and a sweep cannot know a safe body for each. The seed has five roles:
 * a route only a super admin, a Member or the desk reaches is asked, and stops
 * at its refusal (ROADMAP, "Route smoke test: more roles and rows").
 *
 * The route list comes from the folder tree, so a new route is covered the day
 * it is added. Ids in the address are real seeded rows where the seed has one
 * and a well-formed id that matches nothing where it does not; the summary
 * line says how many of each, so thin coverage is visible, not silent.
 */
import fs from "node:fs";
import path from "node:path";
import { expect, test, type Browser } from "@playwright/test";
import { Prisma, PrismaClient } from "@prisma/client";
import { loginAs } from "./fixtures/login";
import { EVENT_ID, EVENT_SLUG, ORG_ID, USERS, type SeedRole } from "./fixtures/seed-constants";

// The whole app folder, not only src/app/api: ten route handlers live outside
// it (uploads, the shared docs, the venue page, health probes, llms.txt).
const APP_ROOT = path.resolve(__dirname, "../src/app");

/** A route file that answers GET, in any of the shapes the codebase exports one. */
const EXPORTS_GET = /export\s+(?:async\s+)?function\s+GET\b|export\s+const\s+GET\b|export\s+const\s*\{[^}]*\bGET\b|export\s*\{[^}]*\bGET\b[^}]*\}/;

/**
 * Routes left out, each with the reason. A key that no longer matches a route
 * on disk fails the suite, so this list cannot rot into hiding a route.
 */
const SKIPPED: Record<string, string> = {};

/**
 * Routes that answer 5xx BY DESIGN on a test server (a dependency that is not
 * configured here), with the status and the reason. Same staleness rule.
 */
const EXPECTED_5XX: Record<string, { status: number[]; why: string }> = {
  "/worker/health": { status: [503], why: "the probe of the worker tier; the test server runs no worker, and 503 is its answer to that" },
};

/** An id that is well formed (a cuid's shape) and matches no row. */
const NO_SUCH_ID = "cmzzzzzzzzzzzzzzzzzzzzzzz";

/** Address parameters that are not a row's id. */
const FIXED_PARAMS: Record<string, string> = {
  eventId: EVENT_ID,
  slug: EVENT_SLUG,
  orgId: ORG_ID,
  token: "smoke-token-0000000000000000",
  index: "0",
  nextauth: "session",
  path: "smoke",
};

/**
 * `[sessionId]` is a row of `eventSession`, and so on, where the name is not
 * the model's. A test below fails if a value here stops naming a Prisma model:
 * the first version held two that never had, and read as "no seeded row".
 */
const MODEL_FOR_PARAM: Record<string, string> = {
  sessionId: "eventSession",
  ticketId: "ticketType",
  campaignId: "rsvpCampaign",
  roomId: "roomType",
  dealId: "crmDeal",
  companyId: "crmCompany",
  crmContactId: "crmContact",
  quoteId: "crmQuote",
  threadId: "crmEmailThread",
  messageId: "crmEmailMessage",
  projectId: "crmProject",
  proposalId: "sessionProposal",
  pollId: "livePoll",
  documentId: "speakerDocument",
  templateId: "certificateTemplate",
  certificateId: "issuedCertificate",
  runId: "certificateIssueRun",
  requestId: "spendRequest",
  commitmentId: "commitment",
  budgetId: "eventBudget",
  reimbursementId: "speakerReimbursement",
  groupId: "registrationGroup",
};

/** Prisma's model names as the client spells its accessors: `EventSession` is `db.eventSession`. */
const PRISMA_MODELS = new Set(Object.values(Prisma.ModelName).map((m) => m[0].toLowerCase() + m.slice(1)));

type Finder = { findFirst(args: unknown): Promise<{ id: string } | null> };

interface SmokeRoute {
  /** `/api/events/[eventId]/speakers`: the address as the folder tree spells it. */
  pattern: string;
  params: string[];
}

function discoverRoutes(): SmokeRoute[] {
  const found: SmokeRoute[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "route.ts" && EXPORTS_GET.test(fs.readFileSync(full, "utf8"))) {
        const segments = path
          .relative(APP_ROOT, path.dirname(full))
          .split(path.sep)
          .filter((s) => s !== "" && !(s.startsWith("(") && s.endsWith(")")));
        const pattern = `/${segments.join("/")}`;
        const params = [...pattern.matchAll(/\[(?:\.\.\.)?([^\]]+)\]/g)].map((m) => m[1]);
        found.push({ pattern, params });
      }
    }
  };
  walk(APP_ROOT);
  return found.sort((a, b) => a.pattern.localeCompare(b.pattern));
}

const ROUTES = discoverRoutes();

/** One real seeded id per address parameter, or null where the seed has no such row. */
async function resolveParamIds(names: string[]): Promise<Record<string, string | null>> {
  const db = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL_TEST });
  const models = db as unknown as Record<string, Finder | undefined>;
  const resolved: Record<string, string | null> = {};
  try {
    for (const name of names) {
      if (name in FIXED_PARAMS) continue;
      const model = models[MODEL_FOR_PARAM[name] ?? name.replace(/Id$/, "")];
      let row: { id: string } | null = null;
      if (model) {
        // A row of this event when the model has one, any row when it has no event column.
        row = await model.findFirst({ where: { eventId: EVENT_ID }, select: { id: true } }).catch(() => null);
        row ??= await model.findFirst({ select: { id: true } }).catch(() => null);
      }
      resolved[name] = row?.id ?? null;
    }
  } finally {
    await db.$disconnect();
  }
  return resolved;
}

interface Answer {
  route: string;
  url: string;
  status: number | "no answer";
  detail: string;
}

/** Ask one address. The status is read from the headers, so a stream that never ends still answers. */
async function ask(baseURL: string, url: string, cookie: string): Promise<{ status: number | "no answer"; detail: string }> {
  try {
    const res = await fetch(`${baseURL}${url}`, {
      headers: cookie ? { cookie } : {},
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status < 500) {
      await res.body?.cancel().catch(() => undefined);
      return { status: res.status, detail: "" };
    }
    const body = await res.text().catch(() => "");
    return { status: res.status, detail: body.replace(/\s+/g, " ").slice(0, 200) };
  } catch (error) {
    return { status: "no answer", detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
}

async function sweep(baseURL: string, cookie: string, ids: Record<string, string | null>): Promise<Answer[]> {
  const queue = ROUTES.filter((r) => !(r.pattern in SKIPPED));
  const answers: Answer[] = [];
  const worker = async () => {
    for (let route = queue.shift(); route; route = queue.shift()) {
      const url = route.pattern.replace(/\[(?:\.\.\.)?([^\]]+)\]/g, (_m, name: string) => FIXED_PARAMS[name] ?? ids[name] ?? NO_SUCH_ID);
      answers.push({ route: route.pattern, url, ...(await ask(baseURL, url, cookie)) });
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return answers;
}

function serverErrors(answers: Answer[]): string[] {
  return answers
    .filter((a) => {
      if (a.status === "no answer") return true;
      if (a.status < 500) return false;
      return !EXPECTED_5XX[a.route]?.status.includes(a.status);
    })
    .map((a) => `${a.status}  ${a.url}  ${a.detail}`)
    .sort();
}

async function cookieFor(browser: Browser, role: SeedRole | null): Promise<string> {
  if (!role) return "";
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await loginAs(page, role);
    return (await context.cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
  } finally {
    await context.close();
  }
}

test.describe("route smoke: no GET route answers with a server error", () => {
  let ids: Record<string, string | null> = {};

  test.beforeAll(async () => {
    ids = await resolveParamIds([...new Set(ROUTES.flatMap((r) => r.params))]);
  });

  test("the route list is read from disk, and the two exception lists name real routes", () => {
    // A floor, not a count to maintain: discovery that silently found nothing would pass every test below.
    expect(ROUTES.length).toBeGreaterThan(250);
    const known = new Set(ROUTES.map((r) => r.pattern));
    expect(Object.keys(SKIPPED).filter((p) => !known.has(p))).toEqual([]);
    expect(Object.keys(EXPECTED_5XX).filter((p) => !known.has(p))).toEqual([]);
    expect(ROUTES.filter((r) => !r.pattern.startsWith("/api/")).length).toBeGreaterThanOrEqual(9);
    expect(Object.entries(MODEL_FOR_PARAM).filter(([, model]) => !PRISMA_MODELS.has(model))).toEqual([]);

    const real = Object.entries(ids).filter(([, id]) => id).map(([name]) => name);
    const placeholder = Object.entries(ids).filter(([, id]) => !id).map(([name]) => name);
    console.log(
      `[route-smoke] ${ROUTES.length} GET routes, ${Object.keys(SKIPPED).length} skipped. ` +
        `Real seeded ids for: ${real.join(", ") || "none"}. No seeded row (asked with an id that matches nothing): ${placeholder.join(", ") || "none"}.`,
    );
  });

  for (const role of [...USERS.map((u) => u.role), null]) {
    test(`as ${role ?? "a signed-out visitor"}`, async ({ browser, baseURL }) => {
      test.setTimeout(300_000);
      const cookie = await cookieFor(browser, role);
      const answers = await sweep(baseURL!, cookie, ids);

      const histogram: Record<string, number> = {};
      for (const a of answers) histogram[String(a.status)] = (histogram[String(a.status)] ?? 0) + 1;
      console.log(`[route-smoke] ${role ?? "signed out"}: ${answers.length} routes asked, ${JSON.stringify(histogram)}`);

      expect(answers.length).toBe(ROUTES.length - Object.keys(SKIPPED).length);
      // Each line: status, address, the first of the body. A 500 here is a route that crashes for this role.
      expect(serverErrors(answers)).toEqual([]);
    });
  }
});
