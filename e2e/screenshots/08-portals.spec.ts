/**
 * Chapter 8 — Self-service portals
 *
 * Each role sees a different post-login landing — manual readers will
 * want screenshots of all of them.
 */
import { test } from "@playwright/test";
import { loginAs } from "../fixtures/login";
import { EVENT_ID } from "../fixtures/seed-constants";
import { snap, maskVolatile } from "./_helpers";

const CHAPTER = "08-portals";

test.describe.configure({ mode: "serial" });

test("registrant portal (/my-account)", async ({ page }) => {
  await loginAs(page, "REGISTRANT", { expectUrl: /my-account|\/e\// });
  await page.goto("/my-account");
  await page.waitForLoadState("networkidle");
  await snap(page, {
    chapter: CHAPTER,
    name: "01-registrant-portal",
    mask: maskVolatile(page),
  });
});

test("reviewer portal (/my-reviews)", async ({ page }) => {
  await loginAs(page, "REVIEWER");
  await page.goto("/my-reviews");
  await page.waitForLoadState("networkidle");
  await snap(page, {
    chapter: CHAPTER,
    name: "02-reviewer-portal",
    mask: maskVolatile(page),
  });
});

test("submitter portal (abstracts list)", async ({ page }) => {
  await loginAs(page, "SUBMITTER");
  // Submitters land on their event's abstracts page after login. The
  // post-login URL is event-scoped (/events/{id}/abstracts) — the
  // loginAs helper waits for any non-/login URL, so we explicitly
  // navigate to the seeded event's abstracts page to guarantee the
  // shot is what the manual expects.
  await page.goto(`/events/${EVENT_ID}/abstracts`);
  await page.waitForLoadState("networkidle");
  await snap(page, {
    chapter: CHAPTER,
    name: "03-submitter-portal",
    mask: maskVolatile(page),
  });
});

test("organizer profile page", async ({ page }) => {
  await loginAs(page, "ADMIN");
  await page.goto("/profile");
  await page.waitForLoadState("networkidle");
  await snap(page, {
    chapter: CHAPTER,
    name: "04-profile-and-signature",
    mask: maskVolatile(page),
  });
});
