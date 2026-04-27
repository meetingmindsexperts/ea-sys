import { expect, test } from "@playwright/test";
import { loginAs, pickSelect } from "./fixtures/login";
import { EVENT_ID } from "./fixtures/seed-constants";

test("admin can create an event and see it in the list", async ({ page }) => {
  await loginAs(page, "ADMIN");

  await page.goto("/events/new");
  // Scope to <main> — Next.js 16 dev sometimes ships both SSR + client DOM
  // trees simultaneously under hydration, and every label/input inside the
  // form has a duplicate in the inert tree. Scoping eliminates the ambiguity.
  const main = page.getByRole("main");
  await expect(
    main.getByText("Create New Event", { exact: true })
  ).toBeVisible();

  const uniqueName = `E2E Smoke Event ${Date.now()}`;

  await main.getByLabel("Event Name").fill(uniqueName);
  await main.getByLabel("Description").fill("Created by the admin-smoke E2E spec.");

  await pickSelect(main, /event type/i, "Conference");

  // datetime-local inputs — format is YYYY-MM-DDTHH:mm
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const nextWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const iso = (d: Date) => d.toISOString().slice(0, 16);

  await main.getByLabel(/^Start Date/).fill(iso(tomorrow));
  await main.getByLabel(/^End Date/).fill(iso(nextWeek));

  await main.getByLabel("Venue Name").fill("E2E Hall");
  await main.getByLabel("City").fill("Dubai");
  await pickSelect(main, /^Country/, "United Arab Emirates");

  await Promise.all([
    page.waitForURL(/\/events\/[^/]+$/, { timeout: 15_000 }),
    page.getByRole("button", { name: /create event/i }).click(),
  ]);

  // Back to list — the newly created event must be visible. The event name
  // appears twice (header + card), so pin to the first link.
  await page.goto("/events");
  await expect(page.getByRole("link", { name: uniqueName }).first()).toBeVisible();
});

test("speaker PUT with stale expectedUpdatedAt → 409 STALE_WRITE", async ({ page }) => {
  // W2-F8 mirror of the registration spec — same lock helper backs the
  // speaker route, so we just need a single round-trip to prove the
  // contract holds for Speaker too. Lighter than the registration spec
  // since the heavy lifting (404 vs 409 disambiguation, transaction
  // rollback) is shared code already covered there + in the
  // optimistic-lock unit tests.
  await loginAs(page, "ADMIN");

  // The seed creates a single speaker (the SUBMITTER user) on the
  // shared E2E event. Pull the row to capture its updatedAt.
  const listRes = await page.request.get(`/api/events/${EVENT_ID}/speakers`);
  expect(listRes.ok()).toBeTruthy();
  const speakers = (await listRes.json()) as Array<{ id: string; updatedAt: string; email: string }>;
  const target = speakers.find((s) => s.email === "submitter@test.local");
  expect(target, "seeded SUBMITTER speaker must exist").toBeDefined();
  if (!target) throw new Error("seed missing");

  const readUpdatedAt = target.updatedAt;

  // CSRF guard in proxy.ts requires the Origin header to match host
  // for cookie-authed PUTs — Playwright's page.request doesn't set
  // Origin automatically. Inject it explicitly.
  const origin = new URL(page.url()).origin;

  // First write with the read-time token bumps updatedAt.
  const fresh = await page.request.put(`/api/events/${EVENT_ID}/speakers/${target.id}`, {
    headers: { Origin: origin },
    data: { bio: "concurrent-write spec — first speaker edit", expectedUpdatedAt: readUpdatedAt },
  });
  expect(fresh.status()).toBe(200);

  // Replay the stale token — must hit the 409 STALE_WRITE branch.
  const stale = await page.request.put(`/api/events/${EVENT_ID}/speakers/${target.id}`, {
    headers: { Origin: origin },
    data: { bio: "concurrent-write spec — stale speaker edit", expectedUpdatedAt: readUpdatedAt },
  });
  expect(stale.status()).toBe(409);
  expect((await stale.json()).code).toBe("STALE_WRITE");
});
