/**
 * Chapter 5 — Accommodation & Hotels
 */
import { test } from "@playwright/test";
import { loginAs } from "../fixtures/login";
import { EVENT_ID } from "../fixtures/seed-constants";
import { snap, maskVolatile } from "./_helpers";

const CHAPTER = "05-accommodation";

test.describe.configure({ mode: "serial" });

test("accommodation overview", async ({ page }) => {
  await loginAs(page, "ADMIN");
  await page.goto(`/events/${EVENT_ID}/accommodation`);
  await page.waitForLoadState("networkidle");
  await snap(page, {
    chapter: CHAPTER,
    name: "01-accommodation-overview",
    mask: maskVolatile(page),
  });
});

test("hotels tab", async ({ page }) => {
  await loginAs(page, "ADMIN");
  await page.goto(`/events/${EVENT_ID}/accommodation`);
  await page.waitForLoadState("networkidle");
  // Try to click any tab/link labeled "Hotels"; falls back to overview if
  // the page doesn't expose a tab.
  const hotelsTab = page.getByRole("tab", { name: /hotels/i }).first();
  if (await hotelsTab.count()) await hotelsTab.click();
  await page.waitForTimeout(300);
  await snap(page, { chapter: CHAPTER, name: "02-hotels-tab" });
});
