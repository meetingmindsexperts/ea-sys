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

test("the Panel Discussion and Q&A presets add editable topics that take their slot on the agenda", async ({ page }) => {
  await loginAs(page, "ADMIN");
  const name = `Presets check ${Date.now()}`;
  const sessionId = await addSession(page, name);
  try {
    await page.goto(`/events/${EVENT_ID}/agenda`);
    // The session card on the calendar (the "needs a speaker" banner names it too).
    await page.getByRole("button", { name: new RegExp(name) }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Edit Session" })).toBeVisible();

    // The organiser chooses: nothing is there until a preset is clicked.
    await expect(dialog.getByPlaceholder("Topic title")).toHaveCount(0);
    await dialog.getByRole("button", { name: "Panel Discussion" }).click();
    await dialog.getByRole("button", { name: "Q&A" }).click();
    const titles = dialog.getByPlaceholder("Topic title");
    await expect(titles).toHaveCount(2);
    await expect(titles.nth(0)).toHaveValue("Panel Discussion");
    await expect(titles.nth(1)).toHaveValue("Q&A");

    // A preset names no speakers: "Presented by" starts at All instead.
    const presentedBy = dialog.getByRole("combobox", { name: "Presented by" });
    await expect(presentedBy).toHaveCount(2);
    await expect(presentedBy.nth(0)).toHaveText("All");
    await expect(dialog.getByText("Select speakers...")).toHaveCount(0);
    await presentedBy.nth(0).click();
    await page.getByRole("option", { name: "All Faculty" }).click();
    await expect(presentedBy.nth(0)).toHaveText("All Faculty");

    // Editable like any topic: rename one, give both their minutes.
    await titles.nth(1).fill("Q&A with the panel");
    const minutes = dialog.getByPlaceholder("Min");
    await minutes.nth(0).fill("40");
    await minutes.nth(1).fill("20");
    await dialog.getByRole("button", { name: "Save Changes" }).click();
    await expect(dialog).toBeHidden();

    await page.goto(`/e/${EVENT_SLUG}/agenda?preview=${EVENT_ID}`);
    await expect(page.getByText("Panel Discussion")).toBeVisible();
    await expect(page.getByText("Q&A with the panel")).toBeVisible();
    // Who presents each, in the organiser's words, never TBA under a preset.
    await expect(page.getByText("All Faculty", { exact: true })).toBeVisible();
    await expect(page.getByText("All", { exact: true })).toBeVisible();
    // The slots follow the minutes: 40 then 20, back to back from the start.
    const times = page.locator(".print-topic-time");
    await expect(times).toHaveCount(2);
    const [first, second] = await times.allInnerTexts();
    const end = (t: string) => t.split("–")[1]?.trim().split(" ")[0];
    const start = (t: string) => t.split("–")[0]?.trim().split(" ")[0];
    expect(start(second)).toBe(end(first));
  } finally {
    await removeSession(page, sessionId);
  }
});

test("the presets are on the session detail panel's topic editor too", async ({ page }) => {
  await loginAs(page, "ADMIN");
  const name = `Presets panel ${Date.now()}`;
  const sessionId = await addSession(page, name);
  try {
    await page.goto(`/events/${EVENT_ID}/agenda`);
    await page.getByRole("button", { name: new RegExp(name) }).hover();
    // Radix renders the tooltip twice (the second copy is for screen readers).
    await page.getByRole("button", { name: "View Details" }).first().click();
    const sheet = page.getByRole("dialog");
    await sheet.getByRole("button", { name: "Edit Topics" }).click();
    await sheet.getByRole("button", { name: "Q&A" }).click();
    await expect(sheet.locator('input[value="Q&A"]')).toHaveCount(1);
    await expect(sheet.getByRole("combobox", { name: "Presented by" })).toHaveText("All");
    await sheet.getByRole("button", { name: "Save" }).click();
    await expect(sheet.getByRole("button", { name: "Edit Topics" })).toBeVisible();

    const res = await page.request.get(`/api/events/${EVENT_ID}/agenda-preview`);
    const body = await res.json();
    const session = body.sessions.find((s: { id: string }) => s.id === sessionId);
    expect(session.topics.map((t: { title: string; presenterLabel: string | null }) => [t.title, t.presenterLabel])).toEqual([
      ["Q&A", "ALL"],
    ]);
    // Saved and shown on the panel, which a preset keeps after a rename.
    await expect(sheet.getByText("Presented by: All")).toBeVisible();
  } finally {
    await removeSession(page, sessionId);
  }
});
