/**
 * Chapter 3 — Registrations & Tickets
 *
 * Covers: registrations list (table view), full-page "Add registration"
 * form, ticket types page, public registration entry point.
 */
import { test } from "@playwright/test";
import { loginAs } from "../fixtures/login";
import { EVENT_ID, EVENT_SLUG } from "../fixtures/seed-constants";
import { snap, maskVolatile } from "./_helpers";

const CHAPTER = "03-registrations";

test.describe.configure({ mode: "serial" });

test("registrations list", async ({ page }) => {
  await loginAs(page, "ADMIN");
  await page.goto(`/events/${EVENT_ID}/registrations`);
  await page.waitForLoadState("networkidle");
  await snap(page, {
    chapter: CHAPTER,
    name: "01-registrations-list",
    mask: maskVolatile(page),
  });
});

test("add-registration full page", async ({ page }) => {
  await loginAs(page, "ADMIN");
  await page.goto(`/events/${EVENT_ID}/registrations/new`);
  await page.waitForLoadState("networkidle");
  await snap(page, { chapter: CHAPTER, name: "02-add-registration-form" });
});

test("ticket types page", async ({ page }) => {
  await loginAs(page, "ADMIN");
  await page.goto(`/events/${EVENT_ID}/tickets`);
  await page.waitForLoadState("networkidle");
  await snap(page, {
    chapter: CHAPTER,
    name: "03-ticket-types",
    mask: maskVolatile(page),
  });
});

test("public registration page (category-picker landing)", async ({ page, context }) => {
  // Public flow — clear cookies so we land as an anonymous visitor.
  await context.clearCookies();
  await page.goto(`/e/${EVENT_SLUG}`);
  await page.waitForLoadState("networkidle");
  await snap(page, { chapter: CHAPTER, name: "04-public-register-landing" });
});
