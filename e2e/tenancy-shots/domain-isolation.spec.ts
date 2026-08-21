/**
 * Every domain, through the running app, as each tenant.
 *
 * WHY THIS TIER EXISTS
 * --------------------
 * There were two test tiers before this and neither could catch what actually
 * went wrong:
 *
 *   - the tenancy harness proves ISOLATION at the database layer, using
 *     synthetic fixtures and a raw client. It never boots the application.
 *   - the unit suite proves UNITS WORK. It cannot prove anything CALLS them.
 *
 * The gap between them is where all four of the August 21 bugs lived: the
 * tenant lane not reaching the Prisma extension, the two public routes reading
 * policied tables outside a lane, and the tenant surface exposing our own
 * infrastructure. Every one produced an EMPTY page rather than an error, and
 * every one passed CI.
 *
 * THE ASSERTION THAT MATTERS IS THE POSITIVE ONE
 * ----------------------------------------------
 * Checking only that tenant A cannot see tenant B's rows is satisfied by a
 * completely broken application: an empty list contains no cross-tenant data
 * either. So each domain asserts BOTH — its own marker present, the other's
 * absent. Presence is what distinguishes working isolation from a dead lane,
 * and it is the half that was missing.
 *
 * Markers are the seeded values from scripts/seed-sandbox.ts, each carrying its
 * tenant's slug, so a substring search over the JSON response is sufficient and
 * does not couple this file to any response shape. Response shapes change; the
 * question "does this tenant's row come back" does not.
 *
 * Prerequisites: see playwright.tenancy.config.ts. Run:
 *   npm run sandbox:setup && npm run sandbox:seed && npm run dev:sandbox
 *   npm run tenancy:isolation
 */
import { test, expect, type Page, type APIResponse } from "@playwright/test";

const PORT = process.env.SANDBOX_PORT ?? "3114";
const PASSWORD = "sandbox123";

interface Tenant {
  key: "acme" | "globex";
  other: "acme" | "globex";
  host: string;
  email: string;
  eventId: string;
}

const TENANTS: Tenant[] = [
  {
    key: "acme",
    other: "globex",
    host: `acme.localhost:${PORT}`,
    email: "admin@acme.test",
    eventId: "sandbox-evt-acme",
  },
  {
    key: "globex",
    other: "acme",
    host: `globex.localhost:${PORT}`,
    email: "admin@globex.test",
    eventId: "sandbox-evt-globex",
  },
];

/**
 * One domain to check.
 *
 * `marker` is a template taking the tenant slug. The SAME template builds this
 * tenant's expected marker and the other tenant's forbidden one, so the two
 * assertions can never drift apart into checking different things.
 */
interface Domain {
  name: string;
  path: (t: Tenant) => string;
  marker: (slug: string) => string;
  /**
   * Set where a domain legitimately returns nothing for a tenant, so the
   * positive assertion is skipped and only isolation is checked. Every entry
   * needs a reason: this flag is the one way to make a domain's check vacuous,
   * and an unexplained one is how a real gap gets waved through.
   */
  absenceOnly?: string;
}

const DOMAINS: Domain[] = [
  {
    name: "events",
    path: () => "/api/events",
    marker: (s) => (s === "acme" ? "Acme Annual Summit" : "Globex Annual Summit"),
  },
  {
    name: "contacts",
    path: () => "/api/contacts?page=1&limit=50",
    marker: (s) => `contact@${s}.test`,
  },
  {
    name: "speakers",
    path: (t) => `/api/events/${t.eventId}/speakers`,
    marker: (s) => `speaker@${s}.test`,
  },
  {
    name: "registrations",
    path: (t) => `/api/events/${t.eventId}/registrations`,
    marker: (s) => `delegate@${s}.test`,
  },
  {
    name: "sessions",
    path: (t) => `/api/events/${t.eventId}/sessions`,
    marker: (s) => (s === "acme" ? "Acme Events Opening" : "Globex Summits Opening"),
  },
  {
    name: "tracks",
    path: (t) => `/api/events/${t.eventId}/tracks`,
    marker: (s) => (s === "acme" ? "Acme Events Main Track" : "Globex Summits Main Track"),
  },
  {
    name: "abstracts",
    path: (t) => `/api/events/${t.eventId}/abstracts`,
    marker: (s) => (s === "acme" ? "Acme Events Abstract" : "Globex Summits Abstract"),
  },
  {
    name: "ticket types",
    path: (t) => `/api/events/${t.eventId}/tickets`,
    // Both tenants name theirs "Delegate", so the PRICE is the discriminator.
    // A shared name is the more honest fixture: it is what a real platform
    // looks like, and it catches a lane that returns the wrong tenant's row
    // rather than no row.
    marker: (s) => (s === "acme" ? '"450"' : '"600"'),
  },
  {
    name: "crm deals",
    path: () => "/api/crm/deals",
    marker: (s) => (s === "acme" ? "Acme Events Platinum" : "Globex Summits Platinum"),
  },
  {
    name: "crm companies",
    path: () => "/api/crm/companies",
    marker: (s) => (s === "acme" ? "Acme Events Sponsor Co" : "Globex Summits Sponsor Co"),
  },
  {
    name: "crm contacts",
    path: () => "/api/crm/contacts",
    marker: (s) => `sponsor@${s}.test`,
  },
];

async function login(page: Page, t: Tenant): Promise<void> {
  await page.goto(`http://${t.host}/login`);
  await page.getByLabel("Email").waitFor({ state: "visible", timeout: 90_000 });
  await page.getByLabel("Email").fill(t.email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: /sign in|log ?in/i }).click();
  await page.waitForLoadState("networkidle").catch(() => undefined);
}

/** A 200 with a readable body, or a failure that names the domain. */
async function readJson(res: APIResponse, domain: string): Promise<string> {
  expect(res.status(), `${domain} did not return 200`).toBe(200);
  return res.text();
}

test.describe.configure({ mode: "serial" });

for (const t of TENANTS) {
  test(`every domain returns ${t.key}'s own rows and none of ${t.other}'s`, async ({ page }) => {
    await login(page, t);

    const missing: string[] = [];
    const leaked: string[] = [];

    for (const d of DOMAINS) {
      const body = await readJson(
        await page.request.get(`http://${t.host}${d.path(t)}`),
        d.name,
      );

      // Collected rather than asserted inline, so ONE run reports every broken
      // domain instead of stopping at the first. When a lane breaks it tends to
      // break everywhere at once, and a report naming eleven domains points at
      // the mechanism while a report naming one points at the domain.
      if (!d.absenceOnly && !body.includes(d.marker(t.key))) missing.push(d.name);
      if (body.includes(d.marker(t.other))) leaked.push(d.name);
    }

    expect(
      leaked,
      `CROSS-TENANT LEAK — ${t.key} could see ${t.other}'s rows in: ${leaked.join(", ")}`,
    ).toEqual([]);

    expect(
      missing,
      `EMPTY — ${t.key} could not see its OWN rows in: ${missing.join(", ")}. ` +
        `Under RLS this is what a missing tenant lane looks like: no error, no ` +
        `log line, just nothing. Check runWithTenant on those routes.`,
    ).toEqual([]);
  });
}

/**
 * The tenant surface itself, narrowed on Aug 21 2026.
 *
 * Not isolation, but the same class of question: a gate written when ADMIN
 * meant an MMG employee, re-read now that it can mean a customer.
 */
test("a tenant admin cannot reach our repository or our infrastructure", async ({ page }) => {
  const t = TENANTS[0];
  await login(page, t);

  for (const path of [
    "/api/admin/docs/tree",
    "/api/admin/docs/search?q=password",
    "/admin/docs/docs/INCIDENTS.md",
  ]) {
    const res = await page.request.get(`http://${t.host}${path}`, { maxRedirects: 0 });
    expect(res.status(), `${path} must not serve the repository to a tenant`).toBe(403);
  }

  // Infra stays reachable, but as the tenant's own service health: the panels
  // that read the HOST or our AWS account must not even be fetched, so their
  // sections report operator-only rather than carrying values.
  const infra = await page.request.get(`http://${t.host}/api/admin/infra`);
  expect(infra.status()).toBe(200);
  const snap = await infra.json();
  expect(snap.scope, "a tenant admin must get the org-scoped snapshot").toBe("org");
  for (const section of ["metrics", "deploys", "ses", "alarms", "dr", "backup", "worker", "jobs"]) {
    expect(snap[section]?.status, `infra.${section} is our infrastructure, not the tenant's`).toBe(
      "operator-only",
    );
  }
});
