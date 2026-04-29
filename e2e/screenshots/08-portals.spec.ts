/**
 * Chapter 8 — Self-service portals
 *
 * Each role sees a different post-login landing — manual readers will
 * want screenshots of all of them.
 */
import { test } from "@playwright/test";
import { loginAs } from "../fixtures/login";
import { snap, maskVolatile } from "./_helpers";

const CHAPTER = "08-portals";

test.describe.configure({ mode: "serial" });

test("registrant portal (/my-registration)", async ({ page }) => {
  await loginAs(page, "REGISTRANT", { expectUrl: /my-registration|\/e\// });
  await page.goto("/my-registration");
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
  // Submitters land on their event's abstracts page after login.
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
