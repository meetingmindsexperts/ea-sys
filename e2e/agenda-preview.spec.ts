import { expect, test, type Page } from "@playwright/test";
import { DEFAULT_PASSWORD, EVENT_ID, EVENT_SLUG, userFor } from "./fixtures/seed-constants";
import { loginAs } from "./fixtures/login";

/**
 * The staff preview of the public agenda (Nov 17, 2026). The seeded event is
 * Published with its agenda NOT published and no sessions, so each test adds
 * one session through the API and deletes it again by its captured id.
 */

// The proxy's CSRF check refuses an API write with no Origin header, and
// Playwright's request client sends none (as certificates-resend.spec.ts).
test.use({ extraHTTPHeaders: async ({ baseURL }, provide) => provide({ Origin: new URL(baseURL!).origin }) });

async function addSession(page: Page, name: string): Promise<string> {
  const eventRes = await page.request.get(`/api/events/${EVENT_ID}`);
  expect(eventRes.ok()).toBeTruthy();
  const event = await eventRes.json();
  const start = new Date(new Date(event.startDate ?? event.event?.startDate).getTime() + 2 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  const res = await page.request.post(`/api/events/${EVENT_ID}/sessions`, {
    data: { name, startTime: start.toISOString(), endTime: end.toISOString() },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).id;
}

async function removeSession(page: Page, sessionId: string) {
  const res = await page.request.delete(`/api/events/${EVENT_ID}/sessions/${sessionId}`);
  expect(res.ok()).toBeTruthy();
}

test("an organiser previews an unpublished agenda from the Agenda page", async ({ page }) => {
  await loginAs(page, "ADMIN");
  const name = `Preview check ${Date.now()}`;
  const sessionId = await addSession(page, name);
  try {
    // The public agenda stays closed: nothing here publishes it.
    const publicRes = await page.request.get(`/api/public/events/${EVENT_SLUG}/agenda`);
    expect(publicRes.status()).toBe(404);

    await page.goto(`/events/${EVENT_ID}/agenda`);
    const [preview] = await Promise.all([
      page.waitForEvent("popup"),
      page.getByRole("link", { name: "Preview" }).click(),
    ]);
    await expect(preview).toHaveURL(new RegExp(`/e/${EVENT_SLUG}/agenda\\?preview=${EVENT_ID}$`));
    await expect(preview.getByRole("status")).toContainText("not published yet");
    await expect(preview.getByText(name)).toBeVisible();
    await expect(preview.locator('meta[name="robots"][data-agenda-preview]')).toHaveAttribute("content", /noindex/);
    await preview.close();
  } finally {
    await removeSession(page, sessionId);
  }
});

test("signed out, the preview asks for a sign-in and comes back to it", async ({ page, browser }) => {
  await loginAs(page, "ADMIN");
  const name = `Preview sign-in ${Date.now()}`;
  const sessionId = await addSession(page, name);
  const guest = await browser.newContext();
  try {
    const visitor = await guest.newPage();
    await visitor.goto(`/e/${EVENT_SLUG}/agenda?preview=${EVENT_ID}`);
    await expect(visitor.getByText("Sign in to preview the agenda")).toBeVisible();
    await expect(visitor.getByText(name)).toHaveCount(0);

    await visitor.getByRole("link", { name: "Sign in" }).click();
    await visitor.getByLabel("Email").fill(userFor("ADMIN").email);
    await visitor.getByLabel("Password").fill(DEFAULT_PASSWORD);
    await visitor.getByRole("button", { name: /sign in/i }).click();

    await expect(visitor).toHaveURL(new RegExp(`/e/${EVENT_SLUG}/agenda\\?preview=${EVENT_ID}$`), { timeout: 15_000 });
    await expect(visitor.getByRole("status")).toContainText("not published yet");
    await expect(visitor.getByText(name)).toBeVisible();
  } finally {
    await guest.close();
    await removeSession(page, sessionId);
  }
});

test("a reviewer cannot preview the agenda", async ({ page }) => {
  await loginAs(page, "REVIEWER");
  await page.goto(`/e/${EVENT_SLUG}/agenda?preview=${EVENT_ID}`);
  await expect(page.getByText("This preview isn’t available to you")).toBeVisible();
});
