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
import { EVENT_ID } from "../fixtures/seed-constants";
import { snap, maskVolatile } from "./_helpers";

const CHAPTER = "11-webinar";

test.describe.configure({ mode: "serial" });

test("webinar console (empty state)", async ({ page }) => {
  await loginAs(page, "ADMIN");
  await page.goto(`/events/${EVENT_ID}/webinar`);
  await page.waitForLoadState("networkidle");
  await snap(page, {
    chapter: CHAPTER,
    name: "01-webinar-console",
    mask: maskVolatile(page),
  });
});
