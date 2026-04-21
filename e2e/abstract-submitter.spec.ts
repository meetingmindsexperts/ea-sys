import { expect, test } from "@playwright/test";
import { EVENT_SLUG } from "./fixtures/seed-constants";
import { pickSelect } from "./fixtures/login";

test("abstract submitter can sign up, then log in and land on events", async ({ page }) => {
  const email = `submitter+${Date.now()}@test.local`;
  const password = "password123";

  await page.goto(`/e/${EVENT_SLUG}/abstract/register`);
  await expect(
    page.getByRole("heading", { name: /abstract submission — speaker registration/i })
  ).toBeVisible();

  // ── Step 1: account ──
  await page.getByPlaceholder("john@university.edu").fill(email);
  await page.getByPlaceholder("Min. 6 characters").fill(password);
  await page.getByPlaceholder("Re-enter password").fill(password);
  await page.getByRole("button", { name: /continue/i }).click();

  // ── Step 2: details ──
  // Includes customSpecialty when specialty=Others per the April 2026 Zod
  // tightening at src/app/e/[slug]/abstract/register/page.tsx:80-85.
  // Custom Selects on public forms aren't wrapped in <FormControl>; accessible
  // name falls back to the placeholder.
  await pickSelect(page, "Title", "Dr.");
  await page.getByPlaceholder("John").fill("Ada");
  await page.getByPlaceholder("Doe").fill("Lovelace");
  await page.getByPlaceholder("Professor, Researcher...").fill("Researcher");
  await page.getByPlaceholder("University of...").fill("Analytical Engine Co.");
  await page.getByPlaceholder("+1 234 567 8900").fill("+971500000000");
  await pickSelect(page, "Select country", "United Arab Emirates");
  await page.getByPlaceholder("Dubai").fill("Dubai");
  await pickSelect(page, "Select specialty", "Others");
  await pickSelect(page, "Select role", "Academia");
  await page.getByPlaceholder("e.g. Interventional Cardiology").fill("Algorithmic Engineering");

  await page.getByRole("button", { name: /create account/i }).click();

  await expect(page.getByRole("heading", { name: /account created/i })).toBeVisible({
    timeout: 10_000,
  });

  // Click through to event-scoped login
  await page.getByRole("link", { name: /log in to continue/i }).click();
  await expect(page).toHaveURL(new RegExp(`/e/${EVENT_SLUG}/login\\?redirect=abstracts`));

  // Event-scoped login form — same field placeholders as the main /login page
  await page.getByRole("textbox", { name: /email/i }).fill(email);
  await page.getByLabel(/^Password/).fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();

  // Per src/app/e/[slug]/login/page.tsx:113, redirect=abstracts sends the user
  // to /events (the events list), not the event-detail or abstracts page.
  await expect(page).toHaveURL(/\/events(?:\?|$|\/)/, { timeout: 15_000 });
});
