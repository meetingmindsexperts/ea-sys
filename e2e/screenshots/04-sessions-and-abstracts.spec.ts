/**
 * Chapter 4 — Sessions, schedule, abstracts (light coverage; empty seeds
 * for these areas are useful for "before you create anything" screenshots).
 */
import { test } from "@playwright/test";
import { loginAs } from "../fixtures/login";
import { EVENT_ID } from "../fixtures/seed-constants";
import { snap, maskVolatile } from "./_helpers";

const CHAPTER = "04-sessions-and-abstracts";

test.describe.configure({ mode: "serial" });

test("schedule (calendar empty state)", async ({ page }) => {
  await loginAs(page, "ADMIN");
  await page.goto(`/events/${EVENT_ID}/schedule`);
  await page.waitForLoadState("networkidle");
  await snap(page, {
    chapter: CHAPTER,
    name: "01-schedule-calendar",
    mask: maskVolatile(page),
  });
});

test("tracks page", async ({ page }) => {
  await loginAs(page, "ADMIN");
  await page.goto(`/events/${EVENT_ID}/tracks`).catch(() => undefined);
  await page.waitForLoadState("networkidle");
  await snap(page, { chapter: CHAPTER, name: "02-tracks-page" });
});

test("abstracts list", async ({ page }) => {
  await loginAs(page, "ADMIN");
  await page.goto(`/events/${EVENT_ID}/abstracts`);
  await page.waitForLoadState("networkidle");
  await snap(page, {
    chapter: CHAPTER,
    name: "03-abstracts-list",
    mask: maskVolatile(page),
  });
});

test("reviewers page", async ({ page }) => {
  await loginAs(page, "ADMIN");
  await page.goto(`/events/${EVENT_ID}/reviewers`);
  await page.waitForLoadState("networkidle");
  await snap(page, { chapter: CHAPTER, name: "04-reviewers" });
});
