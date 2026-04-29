/**
 * Chapter 10 — Check-in (IMG-012), Sponsors (IMG-021), Media (IMG-022),
 * Contacts (IMG-020), Activity feed.
 */
import { test } from "@playwright/test";
import { loginAs } from "../fixtures/login";
import { EVENT_ID } from "../fixtures/seed-constants";
import { snap, maskVolatile } from "./_helpers";

const CHAPTER = "10-checkin-sponsors-media";

test.describe.configure({ mode: "serial" });

test("check-in scanner (IMG-012)", async ({ page, context }) => {
  // Block the camera permission prompt so the page renders the manual
  // search fallback (which is what the manual screenshots anyway).
  await context.grantPermissions([]);
  await loginAs(page, "ADMIN");
  await page.goto(`/events/${EVENT_ID}/check-in`);
  await page.waitForLoadState("networkidle");
  await snap(page, {
    chapter: CHAPTER,
    name: "01-check-in",
    mask: maskVolatile(page),
  });
});

test("sponsors editor (IMG-021)", async ({ page }) => {
  await loginAs(page, "ADMIN");
  await page.goto(`/events/${EVENT_ID}/sponsors`);
  await page.waitForLoadState("networkidle");
  await snap(page, { chapter: CHAPTER, name: "02-sponsors" });
});

test("event media library (IMG-022)", async ({ page }) => {
  await loginAs(page, "ADMIN");
  await page.goto(`/events/${EVENT_ID}/media`);
  await page.waitForLoadState("networkidle");
  await snap(page, {
    chapter: CHAPTER,
    name: "03-event-media",
    mask: maskVolatile(page),
  });
});

test("org-level media library", async ({ page }) => {
  await loginAs(page, "ADMIN");
  await page.goto("/media");
  await page.waitForLoadState("networkidle");
  await snap(page, {
    chapter: CHAPTER,
    name: "04-org-media",
    mask: maskVolatile(page),
  });
});

test("contacts list (IMG-020)", async ({ page }) => {
  await loginAs(page, "ADMIN");
  await page.goto("/contacts");
  await page.waitForLoadState("networkidle");
  await snap(page, {
    chapter: CHAPTER,
    name: "05-contacts",
    mask: maskVolatile(page),
  });
});

test("activity feed", async ({ page }) => {
  await loginAs(page, "ADMIN");
  await page.goto("/activity");
  await page.waitForLoadState("networkidle");
  await snap(page, {
    chapter: CHAPTER,
    name: "06-activity-feed",
    mask: maskVolatile(page),
  });
});
