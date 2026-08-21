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
   * Skip the PRESENCE half: this domain legitimately has nothing of the
   * tenant's to find, so only isolation is checked.
   */
  absenceOnly?: string;
  /**
   * Skip the ABSENCE half: the response genuinely cannot distinguish tenants by
   * content, so the marker matches both and a cross-check would report a leak
   * that is not there.
   *
   * Both flags carry a REASON string rather than a boolean, because each one
   * makes half a domain's check vacuous and an unexplained flag is how a real
   * gap gets waved through. This one was added after the first version used a
   * name as the marker for an endpoint that returns deduplicated bare names
   * shared by both tenants — the test correctly refused to believe it.
   */
  sharedShape?: string;
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
    name: "audience tags",
    path: (t) => `/api/events/${t.eventId}/tags`,
    // Seeded attendees carry no tags, so there is nothing of this tenant's to
    // find and nothing of the other's to leak. The check that matters here is
    // simply that it answers 200 rather than erroring — the wrap added Aug 21
    // reads a policied table, and a broken lane shows up as an empty list that
    // an operator reads as "nobody has been tagged".
    marker: () => "\u0000never",
    absenceOnly: "attendee fixtures carry no tags; 200 is the assertion",
  },
  {
    name: "registration types",
    path: () => "/api/registration-types",
    // Returns bare names, and BOTH tenants seed "Delegate" and "Student", so a
    // name cannot discriminate. That is the honest shape of this endpoint: it
    // is org-wide and deliberately deduplicated, so the only wrong answer it
    // can give is an empty one.
    marker: () => "Delegate",
    sharedShape:
      "returns deduplicated bare type names, and both tenants sell a 'Delegate' " +
      "ticket — nothing in the payload can tell the two apart, so the only wrong " +
      "answer this endpoint can give is an empty one",
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
      if (!d.sharedShape && body.includes(d.marker(t.other))) leaked.push(d.name);
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

/**
 * The platform-operator boundary, exercised for the first time (Aug 21 2026).
 *
 * `canActAsPlatformOperator` has two conditions — SUPER_ADMIN, and membership
 * of PLATFORM_ORG_ID — and until this spec the second one had never executed
 * anywhere. Not master, not the sandbox, not CI. It was unit-tested and unrun.
 *
 * That matters because the whole ADMIN-gate sweep rests on it: ten
 * authorisation sites were changed to ask this predicate instead of
 * `role === "SUPER_ADMIN"`, and "the predicate is correct" and "the predicate
 * runs" are different claims. Both of the day's bugs were the second kind —
 * correct code nothing reached.
 *
 * The fixture is deliberately the awkward one. `super@sandbox.test` is a
 * SUPER_ADMIN belonging to ACME, which is exactly the account the fix exists to
 * refuse and exactly what a customer's own administrator will look like on the
 * platform. `operator@sandbox.test` belongs to the synthetic platform org and
 * must keep everything.
 *
 * Requires `npm run dev:sandbox` (which sets PLATFORM_ORG_ID) and a seed from
 * this repo's scripts/seed-sandbox.ts.
 */
/** The operator console host — sign-in is host-bound, so the operator needs one. */
const PLATFORM_HOST = `platform.localhost:${PORT}`;
const GLOBEX_ORG_ID = "sandbox-org-globex";

const OPS_SURFACES = [
  "/api/logs?since=10m&source=database",
  "/api/organizations",
  "/api/admin/docs/tree",
];

async function loginAs(page: Page, host: string, email: string): Promise<void> {
  await page.goto(`http://${host}/login`);
  await page.getByLabel("Email").waitFor({ state: "visible", timeout: 90_000 });
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: /sign in|log ?in/i }).click();
  await page.waitForLoadState("networkidle").catch(() => undefined);
}

test("a TENANT's SUPER_ADMIN is not a platform operator", async ({ page }) => {
  const acme = TENANTS[0];
  await loginAs(page, acme.host, "super@sandbox.test");

  // Its own tenant still works — the fix must refuse cross-tenant reach, not
  // break the account.
  const own = await page.request.get(`http://${acme.host}/api/events`);
  expect(own.status()).toBe(200);
  expect(await own.text()).toContain("Acme Annual Summit");

  // The x-org-id override is REFUSED: it gets its own org's events back, not
  // Globex's. Before Aug 21 this header was honoured on the role alone, and
  // through PUT /api/organization it was a cross-tenant WRITE.
  const swapped = await page.request.get(`http://${acme.host}/api/events`, {
    headers: { "x-org-id": GLOBEX_ORG_ID },
  });
  expect(swapped.status()).toBe(200);
  const body = await swapped.text();
  expect(body, "x-org-id let a tenant admin read another tenant").not.toContain(
    "Globex Annual Summit",
  );
  expect(body, "the refusal must fall back to the caller's own org, not to nothing").toContain(
    "Acme Annual Summit",
  );

  // Our logs, our organisation list, our repository.
  for (const path of OPS_SURFACES) {
    const res = await page.request.get(`http://${acme.host}${path}`, { maxRedirects: 0 });
    expect(res.status(), `${path} must not serve a tenant SUPER_ADMIN`).toBe(403);
  }
});

test("the platform operator keeps every cross-tenant capability", async ({ page }) => {
  // The other half, and the half that makes the first half meaningful: a guard
  // that refused everyone would pass the test above and be useless.
  //
  // The operator signs in on the OPERATOR CONSOLE host, not a tenant's. That is
  // not a detail of this test — sign-in resolves the tenant from the Host
  // (PLATFORM_DECISIONS §6), so an org with no domain has no door, and until
  // Aug 21 2026 the platform org deliberately had none. Signing in here and
  // then reaching a tenant through `x-org-id` IS the operator flow; it simply
  // was never exercised while login was global.
  await loginAs(page, PLATFORM_HOST, "operator@sandbox.test");

  // The operator's own org holds no events, so an unswapped read is empty —
  // which is what makes the swapped read below unambiguous evidence.
  const own = await page.request.get(`http://${PLATFORM_HOST}/api/events`);
  expect(own.status()).toBe(200);
  expect(await own.text()).not.toContain("Annual Summit");

  const swapped = await page.request.get(`http://${PLATFORM_HOST}/api/events`, {
    headers: { "x-org-id": GLOBEX_ORG_ID },
  });
  expect(swapped.status()).toBe(200);
  expect(await swapped.text()).toContain("Globex Annual Summit");

  for (const path of OPS_SURFACES) {
    const res = await page.request.get(`http://${PLATFORM_HOST}${path}`, { maxRedirects: 0 });
    expect(res.status(), `${path} must remain reachable by the operator`).not.toBe(403);
  }
});

test("a tenant's host is NOT a door into another tenant's account", async ({ page }) => {
  // Sign-in is host-bound, so Globex's admin must not authenticate on Acme's
  // host. It reads as "no such account", which is correct and, as
  // PLATFORM_DECISIONS §6 says, deliberately confusing.
  const acme = TENANTS[0];
  await page.goto(`http://${acme.host}/login`);
  await page.getByLabel(/email/i).fill("admin@globex.test");
  await page.getByLabel(/password/i).fill("sandbox123");
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForTimeout(2500);
  // Still on the login page — not signed in to anything.
  expect(page.url()).toContain("/login");

  // And the same credentials on their OWN host do work, so the refusal above
  // is about the tenant boundary and not about the password.
  await loginAs(page, TENANTS[1].host, "admin@globex.test");
  expect(page.url()).not.toContain("/login");
});

test("the registrant portal returns the caller's own rows, and only their tenant's", async ({
  page,
}) => {
  // Until Aug 21 2026 the /api/registrant/** routes were deliberately left
  // without a tenant lane, pending the identity-model decision (item 6). The
  // consequence was not a leak, it was the opposite: `Registration` carries an
  // RLS policy, so on a platform-shaped deployment the WHOLE portal —
  // my-registration, invoices, quotes, barcodes, promo codes — answered with
  // nothing at all, and no test could see it because the sandbox had zero
  // registrant accounts.
  //
  // A REGISTRANT is org-null on master by design, and these rows sit behind a
  // policy, so the lane cannot come from the session and cannot be read out of
  // the database first. It comes from the host, exactly as sign-in does.
  const eventNameOf = (key: string) =>
    key === "acme" ? "Acme Annual Summit 2026" : "Globex Annual Summit 2026";

  for (const t of TENANTS) {
    await loginAs(page, t.host, `delegate@${t.key}.test`);

    const res = await page.request.get(`http://${t.host}/api/registrant/registrations`);
    expect(res.status(), `${t.key} portal must answer`).toBe(200);

    const body = await res.text();
    // Present, not merely non-empty: an empty list is exactly what a missing
    // lane produces, so asserting "no other tenant" alone would pass against
    // the very bug this pins.
    expect(body, `${t.key} must see its OWN registration`).toContain(eventNameOf(t.key));
    expect(body, `${t.key} must not see ${t.other}'s`).not.toContain(eventNameOf(t.other));

    await page.context().clearCookies();
  }
});
