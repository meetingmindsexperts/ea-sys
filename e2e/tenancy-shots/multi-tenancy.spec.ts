/**
 * Multi-tenancy demonstration shots.
 *
 * Captures the same screens for two tenants, Acme and Globex, against the
 * sandbox. Every pair is meant to be read side by side, because a single
 * screenshot proves nothing about isolation; the evidence is in the difference.
 *
 * WHAT A SCREENSHOT CANNOT SHOW, and how this handles it
 * ------------------------------------------------------
 * The strongest claim here is "the same URL returns a different event on a
 * different host", and a page screenshot contains no address bar, so the image
 * cannot carry that on its own. Rather than paint a fake URL bar into the
 * picture, which is doctored evidence however well-intentioned, the filename
 * and the caption carry the host and the page content carries the tenant. The
 * assertions below are the actual proof; the images illustrate it.
 *
 * Each test asserts what it is about to photograph. A screenshot suite that
 * only takes pictures will happily photograph a broken page, and a wrong image
 * in a deck is worse than a missing one.
 *
 * Run: see playwright.tenancy.config.ts for the prerequisites.
 */
import { test, expect, type Page } from "@playwright/test";
import { snap } from "../screenshots/_helpers";

const CHAPTER = "multi-tenancy";
const PORT = process.env.SANDBOX_PORT ?? "3114";
const PASSWORD = "sandbox123";
const SHARED_SLUG = "annual-summit";

interface Tenant {
  key: string;
  label: string;
  host: string;
  email: string;
  /** Distinguishing string that must appear for this tenant and not the other. */
  eventName: string;
  otherEventName: string;
  /** The OTHER tenant's key, for building its seeded emails. */
  other: string;
  eventId: string;
}

const TENANTS: Tenant[] = [
  {
    key: "acme",
    label: "Acme Events",
    host: `acme.localhost:${PORT}`,
    email: "admin@acme.test",
    eventName: "Acme Annual Summit 2026",
    otherEventName: "Globex Annual Summit 2026",
    other: "globex",
    eventId: "sandbox-evt-acme",
  },
  {
    key: "globex",
    label: "Globex Summits",
    host: `globex.localhost:${PORT}`,
    email: "admin@globex.test",
    eventName: "Globex Annual Summit 2026",
    otherEventName: "Acme Annual Summit 2026",
    other: "acme",
    eventId: "sandbox-evt-globex",
  },
];

const url = (t: Tenant, path: string) => `http://${t.host}${path}`;

async function login(page: Page, t: Tenant): Promise<void> {
  await page.goto(url(t, "/login"));
  await page.getByLabel("Email").waitFor({ state: "visible", timeout: 90_000 });
  await page.getByLabel("Email").fill(t.email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: /sign in|log ?in/i }).click();

  // NEXTAUTH_URL is not set by `npm run dev:sandbox`, so the post-login
  // redirect can land on a different host than the one we signed in on.
  // Navigating explicitly makes the test independent of that, and the session
  // cookie is scoped per host, so the two tenants never share one.
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.goto(url(t, "/events"));
  await page.waitForLoadState("networkidle").catch(() => undefined);
}

test.describe.configure({ mode: "serial" });

/**
 * The headline pair. One path, two hosts, two different events — which is only
 * possible because Event.slug is unique PER ORGANISATION, and the host resolver
 * decides which organisation a request belongs to before the lookup runs.
 */
for (const t of TENANTS) {
  test(`public event page — ${t.key} (no login)`, async ({ page }) => {
    await page.goto(url(t, `/e/${SHARED_SLUG}`));
    await page.waitForLoadState("networkidle").catch(() => undefined);

    await expect(page.getByText(t.eventName).first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(t.otherEventName)).toHaveCount(0);

    await snap(page, { chapter: CHAPTER, name: `01-public-event-${t.key}`, viewportOnly: true });
  });
}

for (const t of TENANTS) {
  test(`dashboard surfaces — ${t.key}`, async ({ page }) => {
    await login(page, t);

    // Events list: this tenant's event, and no sign of the other's.
    await expect(page.getByText(t.eventName).first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(t.otherEventName)).toHaveCount(0);
    await snap(page, { chapter: CHAPTER, name: `02-events-list-${t.key}` });

    // Org-level contacts: an RLS-POLICIED table, one row per tenant.
    //
    // Asserting PRESENCE here is the load-bearing half, and it is not padding.
    // On Aug 21 these pages rendered empty for both tenants because the query
    // extension had lost its AsyncLocalStorage and every policy fail-closed —
    // and an empty list is indistinguishable from correct isolation if you only
    // check that the other tenant is absent. A suite that merely photographs
    // would have produced a deck full of "look, no cross-tenant data" images
    // taken of a broken app.
    await page.goto(url(t, "/contacts"));
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await expect(page.getByText(`contact@${t.key}.test`)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(`contact@${t.other}.test`)).toHaveCount(0);
    await snap(page, { chapter: CHAPTER, name: `03-contacts-${t.key}` });

    // Event-scoped speakers: policied too, reached through the event.
    await page.goto(url(t, `/events/${t.eventId}/speakers`));
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await expect(page.getByText(`speaker@${t.key}.test`)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(`speaker@${t.other}.test`)).toHaveCount(0);
    await snap(page, { chapter: CHAPTER, name: `04-speakers-${t.key}` });
  });
}

/**
 * The negative case, and the one most likely to be forgotten in a demo: a host
 * nobody registered resolves to no tenant at all. Under TENANCY_ENFORCE_HOST=1
 * there is no default organisation to fall back to, so an unknown host cannot
 * quietly serve somebody else's data.
 */
test("unknown host resolves to no tenant", async ({ page, request }) => {
  // Assert the API, not the page navigation. /e/[slug] is a client component,
  // so its shell returns 200 on any host and the lookup happens underneath —
  // asserting the navigation status would pass on a page that had cheerfully
  // rendered somebody else's event.
  const api = await request.get(`http://localhost:${PORT}/api/public/events/${SHARED_SLUG}`);
  expect(api.status(), "an unregistered host must resolve to no tenant").toBe(404);

  // Both tenants hold an event on this exact slug, so naming them individually
  // is what distinguishes "resolved nothing" from "resolved the wrong one".
  await page.goto(`http://localhost:${PORT}/e/${SHARED_SLUG}`);
  await page.waitForLoadState("networkidle").catch(() => undefined);
  for (const t of TENANTS) {
    await expect(page.getByText(t.eventName)).toHaveCount(0);
  }

  await snap(page, { chapter: CHAPTER, name: "05-unknown-host", viewportOnly: true });
});
