import { expect, test } from "@playwright/test";
import { EVENT_SLUG, FREE_CATEGORY_SLUG } from "./fixtures/seed-constants";
import { loginAs } from "./fixtures/login";

/**
 * An organisation's own Role answers reach the public form (step 1d of
 * docs/ORG_FIELDS_PLAN.md): an added answer is offered, a retired one is not.
 * The list is put back afterwards, so the specs that pick Physician or
 * Academia see today's nine.
 */
test("an added Role answer is offered and a retired one is not", async ({ page, browser }) => {
  await loginAs(page, "ADMIN");
  const origin = new URL(page.url()).origin;
  const read = async () => (await (await page.request.get("/api/organization/person-fields")).json()) as {
    role: { answers: { key: string; label: string; retired: boolean }[] };
  };
  const put = (answers: unknown, expected: unknown) =>
    page.request.put("/api/organization/person-fields", {
      headers: { Origin: origin, "Content-Type": "application/json" },
      data: { role: { answers, expected: { answers: expected } } },
    });

  const before = (await read()).role.answers.map(({ key, label, retired }) => ({ key, label, retired }));
  const edited = [...before.map((a) => (a.key === "RESIDENT" ? { ...a, retired: true } : a)), { label: "Engineer", retired: false }];
  expect((await put(edited, before)).status()).toBe(200);

  try {
    const guest = await browser.newPage();
    await guest.goto(`/e/${EVENT_SLUG}/register/${FREE_CATEGORY_SLUG}`);
    await guest.getByPlaceholder("john@example.com").fill(`e2e-role+${Date.now()}@test.local`);
    await guest.getByPlaceholder("Min. 6 characters").fill("password123");
    await guest.getByPlaceholder("Re-enter password").fill("password123");
    await guest.getByRole("button", { name: /continue/i }).click();
    await guest.getByRole("combobox").filter({ hasText: "Select role" }).first().click();
    await expect(guest.getByRole("option", { name: "Engineer", exact: true })).toBeVisible();
    await expect(guest.getByRole("option", { name: "Resident", exact: true })).toHaveCount(0);
    await guest.close();
  } finally {
    // Back to today's nine: Engineer is held by no record, so it can be removed.
    const now = (await read()).role.answers.map(({ key, label, retired }) => ({ key, label, retired }));
    expect((await put(before, now)).status()).toBe(200);
  }
});
