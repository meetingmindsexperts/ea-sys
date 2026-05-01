/**
 * Chapter 11 — Webinar console (IMG-023, IMG-024)
 *
 * The seeded test event is a CONFERENCE, not a WEBINAR — these
 * screenshots will land on the "configure Zoom first" empty-state, which
 * is also a valid manual reference (it's what an admin sees before
 * activation). For the populated-state shots the manual eventually wants,
 * the seed needs to be extended with a WEBINAR-typed event.
 */
import { test } from "@playwright/test";
import { loginAs } from "../fixtures/login";
import { DOCS_WEBINAR_EVENT_ID } from "../fixtures/seed-constants";
import { snap, maskVolatile } from "./_helpers";

const CHAPTER = "11-webinar";

test.describe.configure({ mode: "serial" });

test("webinar console — populated", async ({ page }) => {
  await loginAs(page, "ADMIN");
  await page.goto(`/events/${DOCS_WEBINAR_EVENT_ID}/webinar`);
  await page.waitForLoadState("networkidle");
  await snap(page, {
    chapter: CHAPTER,
    name: "01-webinar-console",
    mask: maskVolatile(page),
  });
});

test("webinar attendance tab (IMG-023)", async ({ page }) => {
  await loginAs(page, "ADMIN");
  await page.goto(`/events/${DOCS_WEBINAR_EVENT_ID}/webinar`);
  await page.waitForLoadState("networkidle");
  // Webinar Console uses Setup/Analytics/Settings tabs — Analytics has the
  // attendance KPIs + table.
  const analyticsTab = page.getByRole("tab", { name: /analytics/i }).first();
  if (await analyticsTab.count()) await analyticsTab.click();
  await page.waitForTimeout(800);
  await snap(page, {
    chapter: CHAPTER,
    name: "02-webinar-attendance",
    mask: maskVolatile(page),
  });
});

test("webinar engagement (polls + Q&A) (IMG-024)", async ({ page }) => {
  await loginAs(page, "ADMIN");
  await page.goto(`/events/${DOCS_WEBINAR_EVENT_ID}/webinar`);
  await page.waitForLoadState("networkidle");
  const analyticsTab = page.getByRole("tab", { name: /analytics/i }).first();
  if (await analyticsTab.count()) await analyticsTab.click();
  await page.waitForTimeout(500);
  // Scroll to the polls/Q&A cards — they're below the attendance KPIs in
  // the Analytics tab.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(300);
  await snap(page, {
    chapter: CHAPTER,
    name: "03-webinar-engagement",
    mask: maskVolatile(page),
  });
});
