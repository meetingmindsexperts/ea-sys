/**
 * Chapter 9 — Finance + Promo Codes (covers IMG-010, IMG-017)
 *
 * Invoices don't have a top-level page; they appear inside each
 * registration detail. We capture the registration list and a single
 * registration detail to surface the Billing & Payments tab.
 */
import { test } from "@playwright/test";
import { loginAs } from "../fixtures/login";
import { EVENT_ID } from "../fixtures/seed-constants";
import { snap, maskVolatile } from "./_helpers";

const CHAPTER = "09-finance-and-promo";

test.describe.configure({ mode: "serial" });

test("promo codes (IMG-010)", async ({ page }) => {
  await loginAs(page, "ADMIN");
  await page.goto(`/events/${EVENT_ID}/promo-codes`);
  await page.waitForLoadState("networkidle");
  await snap(page, {
    chapter: CHAPTER,
    name: "01-promo-codes",
    mask: maskVolatile(page),
  });
});

test("registration detail — invoice + billing tab (IMG-017)", async ({ page }) => {
  await loginAs(page, "ADMIN");
  await page.goto(`/events/${EVENT_ID}/registrations`);
  await page.waitForLoadState("networkidle");
  // Open the first registration row to reveal its detail page.
  const firstRow = page.locator("table tbody tr").first();
  if (await firstRow.count()) {
    await firstRow.click();
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(500);
    await snap(page, {
      chapter: CHAPTER,
      name: "02-registration-detail-invoice",
      mask: maskVolatile(page),
    });
  }
});
