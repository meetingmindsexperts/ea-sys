/**
 * Chapter 4 — Sessions, agenda, abstracts.
 *
 * Sessions live under /events/[id]/agenda (table view) and
 * /events/[id]/agenda/calendar (timeline view). There is no separate
 * /tracks page — tracks are managed inside agenda.
 */
import { test } from "@playwright/test";
import { loginAs } from "../fixtures/login";
import { EVENT_ID } from "../fixtures/seed-constants";
import { snap, maskVolatile } from "./_helpers";

const CHAPTER = "04-sessions-and-abstracts";

test.describe.configure({ mode: "serial" });

test("agenda (sessions list)", async ({ page }) => {
  await loginAs(page, "ADMIN");
  await page.goto(`/events/${EVENT_ID}/agenda`);
  await page.waitForLoadState("networkidle");
  await snap(page, {
    chapter: CHAPTER,
    name: "01-agenda-list",
    mask: maskVolatile(page),
  });
});

test("agenda calendar view", async ({ page }) => {
  await loginAs(page, "ADMIN");
  await page.goto(`/events/${EVENT_ID}/agenda/calendar`);
  await page.waitForLoadState("networkidle");
  await snap(page, {
    chapter: CHAPTER,
    name: "02-agenda-calendar",
    mask: maskVolatile(page),
  });
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
