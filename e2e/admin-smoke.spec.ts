import { expect, test } from "@playwright/test";
import { loginAs, pickSelect } from "./fixtures/login";

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
