/**
 * Chapter 7 — Settings
 *
 * Captures each tab of the org-level Settings page (general, branding,
 * email branding, API keys, OAuth connections, system logs).
 */
import { test } from "@playwright/test";
import { loginAs } from "../fixtures/login";
import { snap, maskVolatile } from "./_helpers";

const CHAPTER = "07-settings";

test.describe.configure({ mode: "serial" });

const TABS: Array<{ tab: string; name: string }> = [
  { tab: "general", name: "01-general" },
  { tab: "branding", name: "02-branding" },
  { tab: "email-branding", name: "03-email-branding" },
  { tab: "api-keys", name: "04-api-keys-and-oauth" },
];

for (const { tab, name } of TABS) {
  test(`settings ${tab}`, async ({ page }) => {
    await loginAs(page, "ADMIN");
    await page.goto(`/settings?tab=${tab}`);
    await page.waitForLoadState("networkidle");
    // Some pages drive the tab via state, not query param — click the
    // matching trigger if the deep-link didn't take.
    const trigger = page.getByRole("tab", { name: new RegExp(tab.replace(/-/g, " "), "i") }).first();
    if (await trigger.count()) await trigger.click().catch(() => undefined);
    await page.waitForTimeout(300);
    await snap(page, {
      chapter: CHAPTER,
      name,
      mask: maskVolatile(page),
    });
  });
}

test("settings users tab", async ({ page }) => {
  await loginAs(page, "ADMIN");
  await page.goto(`/settings?tab=users`);
  await page.waitForLoadState("networkidle");
  await snap(page, {
    chapter: CHAPTER,
    name: "05-users",
    mask: maskVolatile(page),
  });
});
