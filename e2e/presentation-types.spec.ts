import { expect, test, type Page } from "@playwright/test";
import { EVENT_ID } from "./fixtures/seed-constants";
import { loginAs, pickSelect } from "./fixtures/login";

/**
 * An organisation's own presentation type, end to end (step 5 of
 * docs/ABSTRACT_PRESENTATION_TYPES_PLAN.md): added on the Content page, chosen
 * on an abstract, recommended by a reviewer by its name, and the abstract
 * decided. The abstract and the type are removed afterwards, so no other spec
 * sees them.
 */
// E2E_SHOTS=<folder> keeps a screenshot of each step (a visible check: `--headed`).
const shot = async (p: Page, step: string) => {
  if (process.env.E2E_SHOTS) await p.screenshot({ path: `${process.env.E2E_SHOTS}/${step}.png`, fullPage: true });
};

test("an own presentation type is added, submitted with, recommended and decided", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const name = `Case report ${Date.now().toString(36)}`;
  const title = `Own type abstract ${name}`;
  await loginAs(page, "ADMIN");
  const origin = new URL(page.url()).origin;
  const headers = { Origin: origin, "Content-Type": "application/json" };
  let key: string | null = null;
  let abstractId: string | null = null;
  const cleanup: number[] = [];

  try {
    // 1. Added on the Content page: ticked on this event at once.
    await page.goto(`/events/${EVENT_ID}/content`);
    await page.getByRole("tab", { name: "Abstracts" }).click();
    await page.getByLabel("Add a type").fill(name);
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByText(`"${name}" added and offered on this event`)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("checkbox", { name: `Offer ${name} on this event` })).toBeChecked();
    await shot(page, "1-added-on-content-page");
    const list = (await (await page.request.get("/api/organization/presentation-types")).json()) as { types: { key: string; label: string }[] };
    key = list.types.find((t) => t.label === name)?.key ?? null;
    expect(key, "the new type has a key").toBeTruthy();

    // 2. Chosen on an abstract: staff enter one for the seeded submitter.
    await page.goto(`/events/${EVENT_ID}/abstracts/new`);
    await page.getByPlaceholder("Enter a concise, descriptive title for your abstract").fill(title);
    await page.getByPlaceholder("Enter your abstract content here...").fill("An abstract on the organisation's own type.");
    await pickSelect(page, "Select speaker", "Sam Submitter");
    await pickSelect(page, "Select type", name);
    // A required theme picker shows no text until chosen: the third picker in Details (speaker, type, theme).
    const details = page.locator("div").filter({ has: page.getByRole("heading", { name: "Details" }) }).last();
    await details.getByRole("combobox").nth(2).click();
    await page.getByRole("option", { name: "General", exact: true }).click();
    await shot(page, "2-abstract-on-the-type");
    await page.getByRole("button", { name: /submit for review/i }).click();
    await expect(page).toHaveURL(new RegExp(`/events/${EVENT_ID}/abstracts$`), { timeout: 15_000 });
    const abstracts = (await (await page.request.get(`/api/events/${EVENT_ID}/abstracts`)).json()) as Array<{ id: string; title: string; presentationType: string | null }>;
    const created = abstracts.find((a) => a.title === title);
    abstractId = created?.id ?? null;
    expect(created?.presentationType).toBe(key);

    // 3. The pool's reviewer is assigned, and recommends the type by its name.
    const pool = (await (await page.request.get(`/api/events/${EVENT_ID}/reviewers`)).json()) as { reviewers: { userId: string | null; email: string }[] };
    const reviewerId = pool.reviewers.find((r) => r.email === "reviewer@test.local")?.userId;
    expect(reviewerId, "the seeded reviewer is on the pool").toBeTruthy();
    const assigned = await page.request.post(`/api/events/${EVENT_ID}/abstracts/${abstractId}/reviewers`, { headers, data: { userId: reviewerId } });
    expect(assigned.status(), await assigned.text()).toBeLessThan(300);

    const reviewer = await browser.newPage();
    try {
      await loginAs(reviewer, "REVIEWER");
      await reviewer.goto(`/my-reviews/${EVENT_ID}/${abstractId}`);
      await reviewer.getByPlaceholder("Optional").first().fill("80");
      await reviewer.locator("#recommendedFormat").click();
      await reviewer.getByRole("option", { name, exact: true }).click();
      await shot(reviewer, "3-reviewer-recommends-by-name");
      await reviewer.getByRole("button", { name: "Submit review" }).click();
      await expect(reviewer).toHaveURL(/\/my-reviews$/, { timeout: 15_000 });
    } finally {
      await reviewer.close();
    }
    const scores = (await (await page.request.get(`/api/events/${EVENT_ID}/abstracts/${abstractId}/submissions`)).json()) as { submissions?: { recommendedFormat: string | null }[] };
    expect(scores.submissions?.map((s) => s.recommendedFormat)).toEqual([key]);

    // 4. Decided: accepted on its own type (forced: the event needs more reviews than one).
    const decided = await page.request.put(`/api/events/${EVENT_ID}/abstracts/${abstractId}`, { headers, data: { status: "ACCEPTED", forceStatus: true } });
    expect(decided.status(), await decided.text()).toBe(200);
    await page.goto(`/events/${EVENT_ID}/abstracts`);
    const row = page.locator('[data-slot="card"]').filter({ hasText: title });
    await expect(row).toContainText(name);
    await expect(row).toContainText(/accepted/i);
    await shot(page, "4-accepted-on-the-type");
  } finally {
    // No assertion in here: it would replace a failure above.
    if (abstractId) cleanup.push((await page.request.delete(`/api/events/${EVENT_ID}/abstracts/${abstractId}`, { headers })).status());
    if (key) cleanup.push((await page.request.put("/api/organization/presentation-types", { headers, data: { action: "delete", key } })).status());
  }
  expect(cleanup, "the abstract and the type are removed").toEqual([200, 200]);
});
