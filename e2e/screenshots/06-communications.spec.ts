/**
 * Chapter 6 — Communications
 */
import { test } from "@playwright/test";
import { loginAs } from "../fixtures/login";
import { EVENT_ID } from "../fixtures/seed-constants";
import { snap, maskVolatile } from "./_helpers";

const CHAPTER = "06-communications";

test.describe.configure({ mode: "serial" });

test("communications hub", async ({ page }) => {
  await loginAs(page, "ADMIN");
  await page.goto(`/events/${EVENT_ID}/communications`);
  await page.waitForLoadState("networkidle");
  await snap(page, {
    chapter: CHAPTER,
    name: "01-communications-hub",
    mask: maskVolatile(page),
  });
});

test("bulk-email dialog (registrations)", async ({ page }) => {
  await loginAs(page, "ADMIN");
  await page.goto(`/events/${EVENT_ID}/communications`);
  await page.waitForLoadState("networkidle");
  // Open bulk email if there's a launcher button on the page
  const sendBtn = page
    .getByRole("button", { name: /send (bulk )?email/i })
    .first();
  if (await sendBtn.count()) {
    await sendBtn.click();
    await page.waitForTimeout(500);
    await snap(page, {
      chapter: CHAPTER,
      name: "02-bulk-email-dialog",
    });
  }
});

test("content editor (welcome + terms)", async ({ page }) => {
  await loginAs(page, "ADMIN");
  await page.goto(`/events/${EVENT_ID}/content`);
  await page.waitForLoadState("networkidle");
  await snap(page, { chapter: CHAPTER, name: "03-content-editor" });
});
