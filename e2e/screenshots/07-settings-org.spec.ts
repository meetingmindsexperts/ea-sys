/**
 * Chapter 7a — Organization-level Settings
 *
 * Tabs at /settings (org-wide): general, team (users), billing,
 * integrations, api-keys, system. NO branding/email-branding here —
 * those are per-event and live under /events/[id]/settings (chapter 7b).
 */
import { test } from "@playwright/test";
import { loginAs } from "../fixtures/login";
import { snap, maskVolatile } from "./_helpers";

const CHAPTER = "07-settings-org";

test.describe.configure({ mode: "serial" });

const ORG_TABS: Array<{ tab: string; name: string; label: RegExp }> = [
  { tab: "general", name: "01-general", label: /general/i },
  { tab: "team", name: "02-team-users", label: /team|users/i },
  { tab: "billing", name: "03-billing", label: /billing/i },
  { tab: "integrations", name: "04-integrations", label: /integrations/i },
  { tab: "api-keys", name: "05-api-keys-and-oauth", label: /api[ -]?keys/i },
  { tab: "system", name: "06-system-logs", label: /system/i },
];

for (const { tab, name, label } of ORG_TABS) {
  test(`org settings — ${tab}`, async ({ page }) => {
    await loginAs(page, "ADMIN");
    await page.goto(`/settings?tab=${tab}`);
    await page.waitForLoadState("networkidle");
    // Some pages drive the tab via local state, not query params — click
    // the matching trigger if the deep-link didn't take.
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
