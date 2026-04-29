/**
 * Chapter 2 — Speakers
 *
 * Covers: list, "Add speaker" full-page form, detail sheet, "Import from
 * Registrations" dialog. Demonstrates an empty-state (no agreements yet)
 * which is intentional — the manual chapter starts with that view.
 */
import { test } from "@playwright/test";
import { loginAs } from "../fixtures/login";
import { EVENT_ID } from "../fixtures/seed-constants";
import { snap, maskVolatile } from "./_helpers";

const CHAPTER = "02-speakers";

test.describe.configure({ mode: "serial" });

test("speakers list", async ({ page }) => {
  await loginAs(page, "ADMIN");
  await page.goto(`/events/${EVENT_ID}/speakers`);
  await page.waitForLoadState("networkidle");
  await snap(page, {
    chapter: CHAPTER,
    name: "01-speakers-list",
    mask: maskVolatile(page),
  });
});

test("add-speaker full page", async ({ page }) => {
  await loginAs(page, "ADMIN");
  await page.goto(`/events/${EVENT_ID}/speakers/new`);
  await page.waitForLoadState("networkidle");
  await snap(page, { chapter: CHAPTER, name: "02-add-speaker-form" });
});

test("import-from-registrations dialog open", async ({ page }) => {
  await loginAs(page, "ADMIN");
  await page.goto(`/events/${EVENT_ID}/speakers`);
  await page.waitForLoadState("networkidle");
  // Button label might vary; match any button containing "Import"
  const importBtn = page.getByRole("button", { name: /import/i }).first();
  if (await importBtn.count()) {
    await importBtn.click();
    await page.waitForTimeout(500); // dialog open animation
    await snap(page, {
      chapter: CHAPTER,
      name: "03-import-from-registrations-dialog",
    });
  }
});
