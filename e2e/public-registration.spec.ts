import { expect, test } from "@playwright/test";
import { EVENT_SLUG, FREE_CATEGORY_SLUG } from "./fixtures/seed-constants";
import { pickSelect } from "./fixtures/login";

test("public free registration completes without Stripe", async ({ page }) => {
  // Unique email so the route's "attendee already registered" guard doesn't
  // reject replays during local iteration.
  const email = `e2e+${Date.now()}@test.local`;

  await page.goto(`/e/${EVENT_SLUG}/register/${FREE_CATEGORY_SLUG}`);
  await expect(page.getByText("Free Pass Registration", { exact: true })).toBeVisible();

  // ── Step 1: account ──
  // FormLabels include a red "*" span which breaks exact label matches,
  // so target inputs by placeholder text.
  await page.getByPlaceholder("john@example.com").fill(email);
  await page.getByPlaceholder("Min. 6 characters").fill("password123");
  await page.getByPlaceholder("Re-enter password").fill("password123");
  await page.getByRole("button", { name: /continue/i }).click();

  // ── Step 2: details ──
  // Custom Select components on public forms aren't wrapped in <FormControl>,
  // so their accessible name falls back to the placeholder text rather than
  // the FormLabel.
  await pickSelect(page, "Title", "Dr.");
  await page.getByPlaceholder("John").fill("E2E");
  await page.getByPlaceholder("Doe").fill("Tester");
  await page.getByPlaceholder("Physician").fill("Engineer");
  await page.getByPlaceholder("Acme Inc.").fill("E2E Org");
  await page.getByPlaceholder("+1 234 567 8900").fill("+971500000000");
  await pickSelect(page, "Select country", "United Arab Emirates");
  await page.getByPlaceholder("Dubai").fill("Dubai");
  await pickSelect(page, "Select specialty", "Cardiology");
  await pickSelect(page, "Select role", "Physician");

  // Ticket auto-selects when only one is purchasable — see
  // src/app/e/[slug]/register/[category]/page.tsx:269. Assert it's visible so
  // the spec fails loudly if that behaviour changes.
  await expect(page.getByRole("button", { name: /free pass/i })).toBeVisible();

  // Two checkboxes on the page: billingSame (default true) + agreeTerms.
  // The agreeTerms one is last.
  const checkboxes = page.getByRole("checkbox");
  await checkboxes.last().check();

  await Promise.all([
    page.waitForURL(new RegExp(`/e/${EVENT_SLUG}/confirmation`), { timeout: 20_000 }),
    page.getByRole("button", { name: /complete registration/i }).click(),
  ]);

  const url = new URL(page.url());
  expect(url.searchParams.get("id")).toBeTruthy();
  expect(url.hostname).not.toContain("stripe.com");
});
