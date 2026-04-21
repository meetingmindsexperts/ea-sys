import { expect, test } from "@playwright/test";
import { loginAs, pickSelect } from "./fixtures/login";
import { EVENT_ID } from "./fixtures/seed-constants";

test("admin can manually add a paid registration with UNASSIGNED payment status", async ({ page }) => {
  await loginAs(page, "ADMIN");

  await page.goto(`/events/${EVENT_ID}/registrations/new`);

  // Same <main>-scoping pattern as admin-smoke — Next.js 16 dev can ship
  // both SSR + hydrated trees simultaneously, duplicating labels/inputs.
  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { name: /add registration/i })).toBeVisible();

  // 1. Registration Type — trigger shows the placeholder text until picked.
  //    Radix Select's trigger has no aria-label here, so we match the
  //    placeholder via hasText instead of accessible name.
  await pickSelect(main, /no registration type/i, "Standard - $100");

  // 2. Payment Status — confirm the new dropdown is present next to Type
  //    and defaults to "Unassigned". We don't change it — leaving it as
  //    default exercises the UNASSIGNED path end-to-end.
  const paymentTrigger = main.getByRole("combobox", { name: /payment status/i });
  await expect(paymentTrigger).toBeVisible();
  await expect(paymentTrigger).toContainText(/unassigned/i);

  // 3. Attendee details — only firstName/lastName/email are validated
  //    server-side for admin creates; keep this minimal.
  const uniqueEmail = `manual.reg.${Date.now()}@e2e.test`;
  await main.getByLabel(/first name/i).fill("Manny");
  await main.getByLabel(/last name/i).fill("Manual");
  await main.getByLabel(/^email/i).fill(uniqueEmail);

  // 4. Submit → redirects to /events/[id]/registrations on success.
  await Promise.all([
    page.waitForURL(new RegExp(`/events/${EVENT_ID}/registrations(?!/new)`), {
      timeout: 15_000,
    }),
    main.getByRole("button", { name: /create registration/i }).click(),
  ]);

  // 5. The new row is in the list with the UNASSIGNED badge. The list shows
  //    email + status badge in the same row; scope by the unique email so
  //    we can't match another seeded registration by accident.
  const row = page.locator("tr", { hasText: uniqueEmail });
  await expect(row).toBeVisible({ timeout: 10_000 });
  await expect(row).toContainText("UNASSIGNED");
});
