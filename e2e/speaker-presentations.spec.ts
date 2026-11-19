import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { EVENT_ID, EVENT_SLUG, ORG_ID } from "./fixtures/seed-constants";
import { loginAs } from "./fixtures/login";

/**
 * Speaker presentations (Nov 19, 2026; docs/SPEAKER_PRESENTATIONS_PLAN.md):
 * one file per talk, from the staff's speaker page and from the speaker's own
 * form link, which stays open after that form is submitted. The test server
 * runs the local storage provider, so the file goes through the door's own
 * file route; the signed-form path to S3 is covered by unit tests. Everything
 * created is removed by its captured id.
 */

// The proxy's CSRF check refuses an API write with no Origin header.
test.use({ extraHTTPHeaders: async ({ baseURL }, provide) => provide({ Origin: new URL(baseURL!).origin }) });

const dbUrl = process.env.DATABASE_URL_TEST;
if (!dbUrl) throw new Error("DATABASE_URL_TEST is required");
const db = new PrismaClient({ datasources: { db: { url: dbUrl } } });

const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(2000, 0x20)]);
const PPTX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(3000, 0x00)]);
const FAKE = Buffer.from("this is not a pdf at all, just text under a pdf name");

async function choose(page: Page, button: ReturnType<Page["getByRole"]>, file: { name: string; mimeType: string; buffer: Buffer }) {
  const chooser = page.waitForEvent("filechooser");
  await button.click();
  await (await chooser).setFiles(file);
}

test("presentations: staff upload, a fake file refused, replace, download; the speaker's link stays open after submit", async ({ page }) => {
  await loginAs(page, "ADMIN");
  const stamp = Date.now();
  let speakerId: string | null = null;
  let sessionId: string | null = null;
  try {
    const sp = await page.request.post(`/api/events/${EVENT_ID}/speakers`, {
      data: { firstName: "Priya", lastName: `Slides${stamp}`, email: `slides-${stamp}@example.com`, status: "CONFIRMED" },
    });
    expect(sp.status(), await sp.text()).toBe(201);
    speakerId = (await sp.json()).id;
    const ev = await (await page.request.get(`/api/events/${EVENT_ID}`)).json();
    const start = new Date(new Date(ev.startDate ?? ev.event?.startDate).getTime() + 2 * 3600_000);
    const created = await page.request.post(`/api/events/${EVENT_ID}/sessions`, {
      data: {
        name: `Heart failure update ${stamp}`,
        startTime: start.toISOString(),
        endTime: new Date(start.getTime() + 3600_000).toISOString(),
        topics: [{ title: `SGLT2 in practice ${stamp}`, duration: 20, speakerIds: [speakerId] }],
      },
    });
    expect(created.status(), await created.text()).toBe(201);
    sessionId = (await created.json()).id;

    // ── Staff: the speaker page ──
    await page.goto(`/events/${EVENT_ID}/speakers/${speakerId}`);
    const card = page.locator("div").filter({ has: page.getByText("Presentations", { exact: true }) }).filter({ has: page.getByText(`SGLT2 in practice ${stamp}`) }).last();
    await expect(card.getByText(`SGLT2 in practice ${stamp}`)).toBeVisible();
    await expect(card.getByText("Not received yet")).toBeVisible();

    // A text file under a .pdf name is refused after the upload, by its signature.
    await choose(page, card.getByRole("button", { name: "Upload file" }), { name: "fake.pdf", mimeType: "application/pdf", buffer: FAKE });
    await expect(page.getByText(/is not a real \.pdf file/)).toBeVisible();
    await expect(card.getByText("Not received yet")).toBeVisible();

    // A type we do not take is refused before anything is sent.
    await choose(page, card.getByRole("button", { name: "Upload file" }), { name: "notes.docx", mimeType: "application/octet-stream", buffer: PPTX });
    await expect(page.getByText(/file type is not accepted/)).toBeVisible();

    await choose(page, card.getByRole("button", { name: "Upload file" }), { name: "SGLT2 deck.pdf", mimeType: "application/pdf", buffer: PDF });
    await expect(page.getByText("Presentation received")).toBeVisible();
    await expect(card.getByText("SGLT2 deck.pdf")).toBeVisible();
    await expect(card.getByText("Received", { exact: true })).toBeVisible();

    // Replace: one file per talk.
    await choose(page, card.getByRole("button", { name: "Replace file" }), { name: "SGLT2 deck v2.pptx", mimeType: "", buffer: PPTX });
    await expect(card.getByText("SGLT2 deck v2.pptx")).toBeVisible();
    await expect(card.getByText("SGLT2 deck.pdf")).toHaveCount(0);
    const rows = await db.speakerPresentation.findMany({ where: { speakerId: speakerId! }, select: { id: true, status: true, filename: true, size: true }, orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => r.status)).toEqual(["FAILED", "REPLACED", "READY"]);
    expect(Number(rows[2].size)).toBe(PPTX.length);

    // Download: the bytes that were checked, under the uploaded name.
    const dl = await page.request.get(`/api/events/${EVENT_ID}/speakers/${speakerId}/presentations/${rows[2].id}`);
    expect(dl.status()).toBe(200);
    expect(dl.headers()["content-disposition"]).toContain('attachment; filename="SGLT2 deck v2.pptx"');
    expect((await dl.body()).length).toBe(PPTX.length);
    // The replaced file is gone from reach.
    expect((await page.request.get(`/api/events/${EVENT_ID}/speakers/${speakerId}/presentations/${rows[1].id}`)).status()).toBe(404);

    // ── The speaker's own link, on a form already SUBMITTED ──
    const token = `e2e-presentation-token-${stamp}`;
    await db.speakerProfileForm.create({ data: { eventId: EVENT_ID, organizationId: ORG_ID, speakerId: speakerId!, token, status: "SUBMITTED", submittedAt: new Date() } });
    await page.context().clearCookies();
    await page.goto(`/e/${EVENT_SLUG}/speaker-form/${token}`);
    await expect(page.getByText("This form has already been submitted.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Your presentation" })).toBeVisible();
    await expect(page.getByText("SGLT2 deck v2.pptx")).toBeVisible();
    // The speaker sees what was sent, not a download link.
    await expect(page.getByRole("link", { name: /Download/ })).toHaveCount(0);
    await choose(page, page.getByRole("button", { name: "Replace file" }), { name: "Final talk.pdf", mimeType: "application/pdf", buffer: PDF });
    await expect(page.getByText("Presentation received")).toBeVisible();
    await expect(page.getByText("Final talk.pdf")).toBeVisible();
    const last = await db.speakerPresentation.findFirst({ where: { speakerId: speakerId!, status: "READY" }, select: { uploadedVia: true, filename: true } });
    expect(last).toEqual({ uploadedVia: "speaker-form", filename: "Final talk.pdf" });

    // Someone else's token cannot reach this speaker's upload.
    const other = await page.request.post(`/api/public/events/${EVENT_SLUG}/speaker-form/not-a-real-token/presentations`, { data: { slotKey: "general", filename: "x.pdf", size: 10 } });
    expect(other.status()).toBe(404);
  } finally {
    await loginAs(page, "ADMIN");
    if (sessionId) await page.request.delete(`/api/events/${EVENT_ID}/sessions/${sessionId}`);
    if (speakerId) {
      await db.speakerPresentation.deleteMany({ where: { speakerId } });
      await db.speakerProfileForm.deleteMany({ where: { speakerId } });
      await page.request.delete(`/api/events/${EVENT_ID}/speakers/${speakerId}`);
    }
    await db.$disconnect();
  }
});
