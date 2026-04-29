/**
 * Chapter 7b — Event-level Settings
 *
 * Tabs at /events/[eventId]/settings: zoom, general, registration,
 * notifications, abstract-themes, review-criteria, branding,
 * email-branding, email-templates, danger.
 *
 * Branding and email-branding are PER-EVENT (organizer banner, header
 * image, footer image, sender address, CC list, etc.) — not the same
 * thing as the org settings under /settings.
 */
import { test } from "@playwright/test";
import { loginAs } from "../fixtures/login";
import { EVENT_ID } from "../fixtures/seed-constants";
import { snap, maskVolatile } from "./_helpers";

const CHAPTER = "07-settings-event";

test.describe.configure({ mode: "serial" });

const EVENT_TABS: Array<{ tab: string; name: string; label: RegExp }> = [
  { tab: "general", name: "01-general", label: /general/i },
  { tab: "registration", name: "02-registration", label: /registration/i },
  { tab: "branding", name: "03-event-branding", label: /^branding$/i },
  { tab: "email-branding", name: "04-email-branding", label: /email[ -]?branding/i },
  { tab: "email-templates", name: "05-email-templates", label: /email[ -]?templates/i },
  { tab: "notifications", name: "06-notifications", label: /notifications/i },
  { tab: "zoom", name: "07-zoom", label: /zoom/i },
  { tab: "danger", name: "08-danger-zone", label: /danger/i },
];

for (const { tab, name, label } of EVENT_TABS) {
  test(`event settings — ${tab}`, async ({ page }) => {
    await loginAs(page, "ADMIN");
    await page.goto(`/events/${EVENT_ID}/settings?tab=${tab}`);
    await page.waitForLoadState("networkidle");
    const trigger = page.getByRole("tab", { name: label }).first();
    if (await trigger.count()) await trigger.click().catch(() => undefined);
    await page.waitForTimeout(400);
    await snap(page, {
      chapter: CHAPTER,
      name,
      mask: maskVolatile(page),
    });
  });
}
