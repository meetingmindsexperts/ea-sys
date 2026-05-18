/**
 * Chapter 4 — Sessions, agenda, abstracts.
 *
 * Sessions live under /events/[id]/agenda (table view) and
 * /events/[id]/agenda/calendar (timeline view). There is no separate
 * /tracks page — tracks are managed inside agenda.
 */
import { test } from "@playwright/test";
import { loginAs } from "../fixtures/login";
import { EVENT_ID, DOCS_ABSTRACT_ID } from "../fixtures/seed-constants";
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

test("session detail with speaker assignment (IMG-006/008)", async ({ page }) => {
  // There's no standalone /agenda/[sessionId] route — sessions are
  // managed via the agenda list with an inline edit dialog. Click the
  // first session row to surface that dialog and capture it open.
  await loginAs(page, "ADMIN");
  await page.goto(`/events/${EVENT_ID}/agenda`);
  await page.waitForLoadState("networkidle");
  const firstSession = page.locator("table tbody tr").first();
  if (await firstSession.count()) {
    await firstSession.click();
    // Dialog has its own entrance animation; wait briefly so the
    // captured frame isn't half-open.
    await page.waitForTimeout(600);
  }
  await snap(page, {
    chapter: CHAPTER,
    name: "03-session-detail",
    mask: maskVolatile(page),
  });
});

test("abstracts list", async ({ page }) => {
  await loginAs(page, "ADMIN");
  await page.goto(`/events/${EVENT_ID}/abstracts`);
  await page.waitForLoadState("networkidle");
  await snap(page, {
    chapter: CHAPTER,
    name: "04-abstracts-list",
    mask: maskVolatile(page),
  });
});

test("abstract review interface (IMG-016)", async ({ page }) => {
  // The abstract review UI lives at /abstracts/[id]/edit (no plain
  // /abstracts/[id] route). Drilling straight to /edit so the spec
  // captures the actual review panel with criteria scores + decision
  // buttons, not a 404.
  await loginAs(page, "ADMIN");
  await page.goto(`/events/${EVENT_ID}/abstracts/${DOCS_ABSTRACT_ID}/edit`);
  await page.waitForLoadState("networkidle");
  await snap(page, {
    chapter: CHAPTER,
    name: "05-abstract-review",
    mask: maskVolatile(page),
  });
});

test("reviewers page", async ({ page }) => {
  await loginAs(page, "ADMIN");
  await page.goto(`/events/${EVENT_ID}/reviewers`);
  await page.waitForLoadState("networkidle");
  await snap(page, { chapter: CHAPTER, name: "06-reviewers" });
});
