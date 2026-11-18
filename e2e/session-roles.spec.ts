import { expect, test, type Page } from "@playwright/test";
import { EVENT_ID, EVENT_SLUG } from "./fixtures/seed-constants";
import { loginAs } from "./fixtures/login";

/**
 * Session roles an organisation edits (Nov 18, 2026; docs/SESSION_ROLES_PLAN.md):
 * an admin adds a Host that runs the session and hides Panelist in Settings;
 * the session dialog offers Host and not Panelist; the public agenda names
 * the Host. Everything it creates is deleted by its captured id, and the
 * organisation's list is put back as it was.
 */

// The proxy's CSRF check refuses an API write with no Origin header.
test.use({ extraHTTPHeaders: async ({ baseURL }, provide) => provide({ Origin: new URL(baseURL!).origin }) });

type Role = { key: string; label: string; duty: "RUNS" | "PRESENTS"; hidden: boolean };

async function putRoles(page: Page, roles: Array<Omit<Role, "key"> & { key?: string }>) {
  const res = await page.request.put("/api/organization/session-roles", { data: { roles } });
  expect(res.status(), await res.text()).toBe(200);
}

test("an admin adds a Host, and the agenda offers and shows it", async ({ page }) => {
  await loginAs(page, "ADMIN");
  const before: Role[] = (await (await page.request.get("/api/organization/session-roles")).json()).roles;
  const stamp = Date.now();
  let speakerId: string | null = null;
  let sessionId: string | null = null;
  try {
    // Settings, General: add Host (runs the session), hide Panelist, save.
    await page.goto("/settings");
    const card = page.locator("div").filter({ has: page.getByText("Session roles", { exact: true }) }).filter({ has: page.getByLabel("Add a role") }).last();
    await card.getByLabel("Add a role").fill("Host");
    await card.getByRole("combobox", { name: "What the new role does" }).click();
    await page.getByRole("option", { name: "Runs the session" }).click();
    await expect(card.getByText("Host gets the moderation run-sheet.")).toBeVisible();
    await card.getByRole("button", { name: "Add", exact: true }).click();
    await card.getByRole("button", { name: "Hide Panelist" }).click();
    await card.getByRole("button", { name: "Save roles" }).click();
    await expect(page.getByText("Session roles saved")).toBeVisible();

    const saved: Role[] = (await (await page.request.get("/api/organization/session-roles")).json()).roles;
    expect(saved.find((r) => r.label === "Host")).toMatchObject({ key: "host", duty: "RUNS", hidden: false });
    expect(saved.find((r) => r.key === "PANELIST")?.hidden).toBe(true);

    // A speaker and a session holding the Host role.
    const sp = await page.request.post(`/api/events/${EVENT_ID}/speakers`, {
      data: { firstName: "Hana", lastName: `Host${stamp}`, email: `host-${stamp}@example.com`, status: "CONFIRMED" },
    });
    expect(sp.status(), await sp.text()).toBe(201);
    speakerId = (await sp.json()).id;
    const ev = await (await page.request.get(`/api/events/${EVENT_ID}`)).json();
    const start = new Date(new Date(ev.startDate ?? ev.event?.startDate).getTime() + 3 * 60 * 60 * 1000);
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    const name = `Roles check ${stamp}`;
    const created = await page.request.post(`/api/events/${EVENT_ID}/sessions`, {
      data: { name, startTime: start.toISOString(), endTime: end.toISOString(), sessionRoles: [{ speakerId, role: "host" }] },
    });
    expect(created.status(), await created.text()).toBe(201);
    sessionId = (await created.json()).id;

    // The session dialog: the row reads Host; the picker offers Host and not Panelist.
    await page.goto(`/events/${EVENT_ID}/agenda`);
    await page.getByRole("button", { name: new RegExp(name) }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Edit Session" })).toBeVisible();
    const roleSelect = dialog.getByRole("combobox").filter({ hasText: /^Host$/ }).first();
    await expect(roleSelect).toBeVisible();
    await roleSelect.click();
    await expect(page.getByRole("option", { name: "Host" })).toBeVisible();
    await expect(page.getByRole("option", { name: "Moderator" })).toBeVisible();
    await expect(page.getByRole("option", { name: "Panelist" })).toHaveCount(0);
    await page.keyboard.press("Escape");

    // The public agenda (preview: the seeded agenda is unpublished) names the Host.
    await page.goto(`/e/${EVENT_SLUG}/agenda?preview=${EVENT_ID}`);
    const card2 = page.locator(".print-session-card").filter({ hasText: name });
    await expect(card2.getByText("Host", { exact: true })).toBeVisible();
    await expect(card2.getByText("Moderator", { exact: true })).toHaveCount(0);
  } finally {
    if (sessionId) expect((await page.request.delete(`/api/events/${EVENT_ID}/sessions/${sessionId}`)).ok()).toBeTruthy();
    if (speakerId) expect((await page.request.delete(`/api/events/${EVENT_ID}/speakers/${speakerId}`)).ok()).toBeTruthy();
    await putRoles(page, before.map(({ key, label, duty, hidden }) => ({ key, label, duty, hidden })));
  }
});

test("an event turns a role off: the server and new rows refuse it, the person who holds it keeps it", async ({ page }) => {
  await loginAs(page, "ADMIN");
  const before: Role[] = (await (await page.request.get("/api/organization/session-roles")).json()).roles;
  const stamp = Date.now();
  let speakerId: string | null = null;
  let sessionId: string | null = null;
  try {
    await putRoles(page, [
      ...before.map(({ key, label, duty, hidden }) => ({ key, label, duty, hidden })),
      { label: "Host", duty: "RUNS", hidden: false },
    ]);

    // A session where someone already holds Host.
    const sp = await page.request.post(`/api/events/${EVENT_ID}/speakers`, {
      data: { firstName: "Omar", lastName: `Off${stamp}`, email: `off-${stamp}@example.com`, status: "CONFIRMED" },
    });
    expect(sp.status(), await sp.text()).toBe(201);
    speakerId = (await sp.json()).id;
    const ev = await (await page.request.get(`/api/events/${EVENT_ID}`)).json();
    const start = new Date(new Date(ev.startDate ?? ev.event?.startDate).getTime() + 5 * 60 * 60 * 1000);
    const name = `Roles off ${stamp}`;
    const created = await page.request.post(`/api/events/${EVENT_ID}/sessions`, {
      data: {
        name,
        startTime: start.toISOString(),
        endTime: new Date(start.getTime() + 3_600_000).toISOString(),
        sessionRoles: [{ speakerId, role: "host" }],
      },
    });
    expect(created.status(), await created.text()).toBe(201);
    sessionId = (await created.json()).id;

    // Event settings, Registration tab, Agenda card: untick Host and save.
    await page.goto(`/events/${EVENT_ID}/settings`);
    await page.getByRole("tab", { name: "Registration" }).click();
    const host = page.getByRole("checkbox", { name: "Offer Host on this event" });
    await expect(host).toBeChecked();
    await host.click();
    await page.getByRole("button", { name: "Save registration settings" }).click();
    await expect.poll(async () => (await (await page.request.get(`/api/events/${EVENT_ID}`)).json()).settings?.hiddenSessionRoles).toEqual(["host"]);

    // The server refuses a new Host here too, not only the picker.
    const refused = await page.request.post(`/api/events/${EVENT_ID}/sessions`, {
      data: {
        name: `Roles refused ${stamp}`,
        startTime: start.toISOString(),
        endTime: new Date(start.getTime() + 3_600_000).toISOString(),
        sessionRoles: [{ speakerId, role: "host" }],
      },
    });
    expect(refused.status()).toBe(400);
    expect((await refused.json()).code).toBe("SESSION_ROLE_NOT_OFFERED");

    await page.goto(`/events/${EVENT_ID}/agenda`);
    await page.getByRole("button", { name: new RegExp(name) }).click();
    const dialog = page.getByRole("dialog");
    // The holder's row still reads Host and offers it.
    const held = dialog.getByRole("combobox").filter({ hasText: /^Host$/ }).first();
    await held.click();
    await expect(page.getByRole("option", { name: "Host" })).toBeVisible();
    await page.keyboard.press("Escape");
    // A new row does not.
    await dialog.getByRole("button", { name: "Add Role" }).click();
    // The new row's role picker (not the speaker picker beside it, "Select speaker").
    await dialog.getByRole("combobox").filter({ hasText: /^Speaker$/ }).last().click();
    await expect(page.getByRole("option", { name: "Moderator" })).toBeVisible();
    await expect(page.getByRole("option", { name: "Host" })).toHaveCount(0);
    await page.keyboard.press("Escape");
  } finally {
    if (sessionId) expect((await page.request.delete(`/api/events/${EVENT_ID}/sessions/${sessionId}`)).ok()).toBeTruthy();
    if (speakerId) expect((await page.request.delete(`/api/events/${EVENT_ID}/speakers/${speakerId}`)).ok()).toBeTruthy();
    const restore = await page.request.put(`/api/events/${EVENT_ID}`, { data: { settings: { hiddenSessionRoles: [] } } });
    expect(restore.ok(), await restore.text()).toBeTruthy();
    await putRoles(page, before.map(({ key, label, duty, hidden }) => ({ key, label, duty, hidden })));
  }
});
