import { expect, type Locator, type Page } from "@playwright/test";
import { DEFAULT_PASSWORD, userFor, type SeedRole } from "./seed-constants";

/**
 * Log in via the /login form. Waits for NextAuth to set the session cookie by
 * watching for navigation away from the login page.
 */
export async function loginAs(
  page: Page,
  role: SeedRole,
  options: { password?: string; expectUrl?: RegExp } = {}
) {
  const { email } = userFor(role);
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(options.password ?? DEFAULT_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();

  if (options.expectUrl) {
    await expect(page).toHaveURL(options.expectUrl, { timeout: 15_000 });
  } else {
    // Default: any URL that isn't /login
    await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
      timeout: 15_000,
    });
  }
}

/**
 * Select an option inside a Radix Select (shadcn) combobox.
 *
 * Tries two strategies, in order:
 *   1. By accessible name — works when the trigger is wrapped in <FormControl>
 *      so shadcn wires the FormLabel's htmlFor to the button (e.g. admin forms).
 *   2. By visible text — works for public forms where the Select is rendered
 *      directly inside FormItem and Radix exposes the placeholder text only.
 *
 * Pass the text you see on the trigger (label OR placeholder).
 */
export async function pickSelect(
  scope: Page | Locator,
  triggerText: string | RegExp,
  option: string
) {
  const byName = scope.getByRole("combobox", { name: triggerText });
  const byText = scope.getByRole("combobox").filter({ hasText: triggerText });
  const trigger = byName.or(byText).first();
  await trigger.click();
  // The popup portal is outside `scope`, so look up the option on the page.
  const page = "page" in scope ? scope.page() : scope;
  await page.getByRole("option", { name: option, exact: true }).click();
}
