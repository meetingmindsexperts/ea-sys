/**
 * Chapter 1 — Getting Started
 *
 * Covers: login form, dashboard overview, event list, single event landing
 * (the four screens a brand-new operator sees in the first 30 seconds).
 */
import { test } from "@playwright/test";
import { loginAs } from "../fixtures/login";
import { EVENT_ID } from "../fixtures/seed-constants";
import { snap, maskVolatile } from "./_helpers";

const CHAPTER = "01-getting-started";

test.describe.configure({ mode: "serial" });

test("login form — empty + filled", async ({ page }) => {
  await page.goto("/login");
  // Wait for the form to mount (RHF + first-compile can take ~60s on a
  // cold dev server).
  await page.getByLabel("Email").waitFor({ state: "visible", timeout: 90_000 });
  await snap(page, { chapter: CHAPTER, name: "01-login-form-empty" });

  await page.getByLabel("Email").fill("admin@test.local");
  await page.getByLabel("Password").fill("password123");
  await snap(page, { chapter: CHAPTER, name: "02-login-form-filled" });
});

test("dashboard after login", async ({ page }) => {
  await loginAs(page, "ADMIN");
  await page.goto("/dashboard");
  await page.waitForLoadState("networkidle");
  await snap(page, {
    chapter: CHAPTER,
    name: "03-dashboard-overview",
    mask: maskVolatile(page),
  });
});

test("events list page", async ({ page }) => {
  await loginAs(page, "ADMIN");
  await page.goto("/events");
  await page.waitForLoadState("networkidle");
  await snap(page, {
    chapter: CHAPTER,
    name: "04-events-list",
    mask: maskVolatile(page),
  });
});

test("event landing page (single event view)", async ({ page }) => {
  await loginAs(page, "ADMIN");
  await page.goto(`/events/${EVENT_ID}`);
  await page.waitForLoadState("networkidle");
  await snap(page, {
    chapter: CHAPTER,
    name: "05-event-landing",
    mask: maskVolatile(page),
  });
});
