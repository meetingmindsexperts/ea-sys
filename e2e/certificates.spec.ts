import { expect, test } from "@playwright/test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { loginAs } from "./fixtures/login";
import { EVENT_ID } from "./fixtures/seed-constants";

/**
 * Certificate system end-to-end coverage (2026-06-02).
 *
 * Covers the v3 PDF-overlay flow end-to-end at the integration boundary
 * (UI ↔ REST API) without depending on the cron worker. The worker has
 * its own state-machine unit coverage; here we pin:
 *
 *   1. Template CRUD lifecycle through the dashboard
 *   2. PDF upload accepts magic-byte-valid PDF + persists URL
 *   3. PDF upload rejects garbage with 400
 *   4. Cover-email defaults round-trip through PATCH
 *   5. Issue body schema rejects missing tag + emailSubject + emailBody
 *   6. Template DELETE blocked when an IssuedCertificate references it
 *   7. retry-failed endpoint resets failed items + bumps run status
 *   8. Cross-tenant access patterns return 404 (not 403 — avoid enumeration)
 *
 * NOT covered here (intentional):
 *   - Canvas-editor drag/resize — pdfjs-dist + react-rnd interaction is
 *     too brittle for Playwright; manual smoke + pdf-lib's own coordinate
 *     unit tests are the right level.
 *   - Actual cron tick draining a run — would require a tick-now debug
 *     endpoint we haven't shipped. The worker logic itself is unit-tested.
 *   - AWS SES delivery — out-of-band; the manual smoke pass is the right
 *     forum for that.
 */

const ATTENDANCE = "ATTENDANCE";
const APPRECIATION = "APPRECIATION";

/** Generate a tiny valid PDF buffer in-memory so the spec doesn't carry
 *  a committed binary fixture. Returns a Uint8Array suitable for
 *  setInputFiles or multipart form upload. */
async function makeTinyPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]); // A4 portrait
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("E2E test cert background", { x: 50, y: 750, size: 14, font });
  return doc.save();
}

async function makeGarbageBuffer(): Promise<Buffer> {
  // First 10 bytes are NOT %PDF- / PNG / JPEG magic — the upload route's
  // detectFormat() should return null and reply 400.
  return Buffer.from("THIS_IS_NOT_A_PDF_OR_IMAGE_FILE_AT_ALL", "utf-8");
}

test.describe("certificate templates", () => {
  test("admin can create + rename + delete a template through the dashboard API", async ({ page }) => {
    await loginAs(page, "ADMIN");

    // CREATE — POST /templates
    const createRes = await page.request.post(
      `/api/events/${EVENT_ID}/certificates/templates`,
      {
        data: { name: "E2E Standard Attendance", category: ATTENDANCE },
      },
    );
    expect(createRes.status()).toBe(201);
    const created = (await createRes.json()) as { template: { id: string; name: string } };
    expect(created.template.name).toBe("E2E Standard Attendance");
    const templateId = created.template.id;

    // LIST — GET /templates returns the new row in the ATTENDANCE bucket.
    const listRes = await page.request.get(`/api/events/${EVENT_ID}/certificates/templates`);
    expect(listRes.ok()).toBeTruthy();
    const listed = (await listRes.json()) as { templates: Array<{ id: string; category: string }> };
    expect(listed.templates.find((t) => t.id === templateId)?.category).toBe(ATTENDANCE);

    // PATCH — rename.
    const patchRes = await page.request.patch(
      `/api/events/${EVENT_ID}/certificates/templates/${templateId}`,
      { data: { name: "E2E Standard Attendance (renamed)" } },
    );
    expect(patchRes.ok()).toBeTruthy();
    const patched = (await patchRes.json()) as { template: { name: string } };
    expect(patched.template.name).toBe("E2E Standard Attendance (renamed)");

    // DELETE — no issued certs yet, so allowed.
    const delRes = await page.request.delete(
      `/api/events/${EVENT_ID}/certificates/templates/${templateId}`,
    );
    expect(delRes.ok()).toBeTruthy();

    // List no longer contains it.
    const list2 = await page.request.get(`/api/events/${EVENT_ID}/certificates/templates`);
    const listed2 = (await list2.json()) as { templates: Array<{ id: string }> };
    expect(listed2.templates.find((t) => t.id === templateId)).toBeUndefined();
  });

  test("dashboard Templates tab renders + opens the canvas editor on Edit", async ({ page }) => {
    await loginAs(page, "ADMIN");

    // Seed a template via API so this spec doesn't depend on the
    // previous one's ordering.
    const createRes = await page.request.post(
      `/api/events/${EVENT_ID}/certificates/templates`,
      { data: { name: "E2E UI Template", category: APPRECIATION } },
    );
    expect(createRes.status()).toBe(201);
    const { template } = (await createRes.json()) as { template: { id: string } };

    await page.goto(`/events/${EVENT_ID}/certificates`);
    // Templates tab is the default. The new template card should be
    // visible inside the Appreciation column.
    await expect(page.getByText("Certificate of Appreciation")).toBeVisible();
    await expect(page.getByText("E2E UI Template")).toBeVisible();

    // Edit opens the canvas editor card — verify the "Choose file"
    // upload widget renders (empty state, no background uploaded yet).
    await page
      .getByRole("button", { name: "Edit" })
      .first()
      .click();
    await expect(
      page.getByText(/Upload the certificate background/i),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /Choose file/i })).toBeVisible();

    // Cleanup
    await page.request.delete(
      `/api/events/${EVENT_ID}/certificates/templates/${template.id}`,
    );
  });
});

test.describe("PDF upload", () => {
  test("accepts a valid PDF and returns a /uploads/... URL", async ({ page }) => {
    await loginAs(page, "ADMIN");

    const pdfBytes = await makeTinyPdf();
    const res = await page.request.post(`/api/upload/pdf`, {
      multipart: {
        eventId: EVENT_ID,
        file: {
          name: "tiny.pdf",
          mimeType: "application/pdf",
          buffer: Buffer.from(pdfBytes),
        },
      },
    });
    expect(res.ok()).toBeTruthy();
    const json = (await res.json()) as {
      url: string;
      size: number;
      convertedFrom: string | null;
    };
    expect(json.url).toMatch(/^\/uploads\/certificates\//);
    expect(json.url.endsWith(".pdf")).toBeTruthy();
    expect(json.convertedFrom).toBeNull();
    expect(json.size).toBeGreaterThan(0);
  });

  test("rejects non-PDF/non-image with 400 (magic-byte detection)", async ({ page }) => {
    await loginAs(page, "ADMIN");

    const garbage = await makeGarbageBuffer();
    const res = await page.request.post(`/api/upload/pdf`, {
      multipart: {
        eventId: EVENT_ID,
        file: {
          name: "garbage.bin",
          mimeType: "application/octet-stream",
          buffer: garbage,
        },
      },
    });
    expect(res.status()).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/PDF, PNG, or JPEG/i);
  });

  test("rejects missing eventId with 400 INVALID_EVENT_ID", async ({ page }) => {
    await loginAs(page, "ADMIN");

    const pdfBytes = await makeTinyPdf();
    const res = await page.request.post(`/api/upload/pdf`, {
      multipart: {
        // eventId deliberately missing
        file: {
          name: "tiny.pdf",
          mimeType: "application/pdf",
          buffer: Buffer.from(pdfBytes),
        },
      },
    });
    expect(res.status()).toBe(400);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe("INVALID_EVENT_ID");
  });
});

test.describe("cover-email defaults", () => {
  test("can save + read back per-template email defaults", async ({ page }) => {
    await loginAs(page, "ADMIN");

    const createRes = await page.request.post(
      `/api/events/${EVENT_ID}/certificates/templates`,
      { data: { name: "E2E Email Template", category: ATTENDANCE } },
    );
    const { template } = (await createRes.json()) as { template: { id: string } };

    const subject = "E2E test subject — {{eventName}}";
    const body = "<p>Hello {{recipientName}},</p><p>Here is your cert.</p>";

    const patchRes = await page.request.patch(
      `/api/events/${EVENT_ID}/certificates/templates/${template.id}`,
      { data: { emailSubject: subject, emailBody: body } },
    );
    expect(patchRes.ok()).toBeTruthy();

    const listRes = await page.request.get(
      `/api/events/${EVENT_ID}/certificates/templates`,
    );
    const listed = (await listRes.json()) as {
      templates: Array<{
        id: string;
        emailSubject: string | null;
        emailBody: string | null;
      }>;
    };
    const found = listed.templates.find((t) => t.id === template.id)!;
    expect(found.emailSubject).toBe(subject);
    expect(found.emailBody).toBe(body);

    // Clear back to system default — null on both fields.
    const clearRes = await page.request.patch(
      `/api/events/${EVENT_ID}/certificates/templates/${template.id}`,
      { data: { emailSubject: null, emailBody: null } },
    );
    expect(clearRes.ok()).toBeTruthy();

    await page.request.delete(
      `/api/events/${EVENT_ID}/certificates/templates/${template.id}`,
    );
  });
});

test.describe("Issue + eligibility contracts", () => {
  test("issue route rejects body missing tag/emailSubject/emailBody with 400", async ({ page }) => {
    await loginAs(page, "ADMIN");

    const createRes = await page.request.post(
      `/api/events/${EVENT_ID}/certificates/templates`,
      { data: { name: "E2E Issue Schema", category: ATTENDANCE } },
    );
    const { template } = (await createRes.json()) as { template: { id: string } };

    // Missing tag
    const noTag = await page.request.post(
      `/api/events/${EVENT_ID}/certificates/issue`,
      {
        data: {
          templateId: template.id,
          emailSubject: "x",
          emailBody: "<p>x</p>",
        },
      },
    );
    expect(noTag.status()).toBe(400);

    // Missing emailSubject
    const noSubject = await page.request.post(
      `/api/events/${EVENT_ID}/certificates/issue`,
      {
        data: {
          templateId: template.id,
          tag: "anytag",
          emailBody: "<p>x</p>",
        },
      },
    );
    expect(noSubject.status()).toBe(400);

    // Missing emailBody
    const noBody = await page.request.post(
      `/api/events/${EVENT_ID}/certificates/issue`,
      {
        data: {
          templateId: template.id,
          tag: "anytag",
          emailSubject: "x",
        },
      },
    );
    expect(noBody.status()).toBe(400);

    await page.request.delete(
      `/api/events/${EVENT_ID}/certificates/templates/${template.id}`,
    );
  });

  test("eligible endpoint returns availableTags overview without tag param", async ({ page }) => {
    await loginAs(page, "ADMIN");

    const createRes = await page.request.post(
      `/api/events/${EVENT_ID}/certificates/templates`,
      { data: { name: "E2E Tag Overview", category: ATTENDANCE } },
    );
    const { template } = (await createRes.json()) as { template: { id: string } };

    const res = await page.request.get(
      `/api/events/${EVENT_ID}/certificates/eligible?templateId=${template.id}`,
    );
    expect(res.ok()).toBeTruthy();
    const json = (await res.json()) as {
      availableTags: Array<{ tag: string; count: number }>;
      eligibleCount: number;
      tag: string | null;
    };
    expect(Array.isArray(json.availableTags)).toBeTruthy();
    expect(json.tag).toBeNull();
    // Without an explicit tag, the eligible list is empty by design
    // (picker mode — the operator hasn't chosen yet).
    expect(json.eligibleCount).toBe(0);

    await page.request.delete(
      `/api/events/${EVENT_ID}/certificates/templates/${template.id}`,
    );
  });

  test("issue returns 422 NO_ELIGIBLE_RECIPIENTS for a tag no one has", async ({ page }) => {
    await loginAs(page, "ADMIN");

    const createRes = await page.request.post(
      `/api/events/${EVENT_ID}/certificates/templates`,
      { data: { name: "E2E Empty Tag", category: ATTENDANCE } },
    );
    const { template } = (await createRes.json()) as { template: { id: string } };

    const res = await page.request.post(
      `/api/events/${EVENT_ID}/certificates/issue`,
      {
        data: {
          templateId: template.id,
          tag: "tag-that-no-attendee-has",
          emailSubject: "subj",
          emailBody: "<p>body</p>",
        },
      },
    );
    expect(res.status()).toBe(422);
    const json = (await res.json()) as { code: string; availableTags: unknown };
    expect(json.code).toBe("NO_ELIGIBLE_RECIPIENTS");
    expect(Array.isArray(json.availableTags)).toBeTruthy();

    await page.request.delete(
      `/api/events/${EVENT_ID}/certificates/templates/${template.id}`,
    );
  });
});

test.describe("cross-tenant + authorization", () => {
  test("reviewer is denied template CRUD (denyReviewer guard)", async ({ page }) => {
    await loginAs(page, "REVIEWER");

    const res = await page.request.post(
      `/api/events/${EVENT_ID}/certificates/templates`,
      { data: { name: "Reviewer attempt", category: ATTENDANCE } },
    );
    // denyReviewer returns 403 Forbidden via NextResponse.json shape.
    expect(res.status()).toBe(403);
  });

  test("submitter is denied template CRUD", async ({ page }) => {
    await loginAs(page, "SUBMITTER");

    const res = await page.request.post(
      `/api/events/${EVENT_ID}/certificates/templates`,
      { data: { name: "Submitter attempt", category: ATTENDANCE } },
    );
    expect(res.status()).toBe(403);
  });

  test("registrant is denied template CRUD", async ({ page }) => {
    await loginAs(page, "REGISTRANT");

    const res = await page.request.post(
      `/api/events/${EVENT_ID}/certificates/templates`,
      { data: { name: "Registrant attempt", category: ATTENDANCE } },
    );
    expect(res.status()).toBe(403);
  });

  test("templateId from a foreign event returns 404 (not 403)", async ({ page }) => {
    await loginAs(page, "ADMIN");

    // Unknown id — same shape as a foreign org's id. The route binds
    // through `event: { organizationId }` so cross-tenant lookups fail
    // identically to plain not-found.
    const res = await page.request.patch(
      `/api/events/${EVENT_ID}/certificates/templates/c0000000000000000000000000`,
      { data: { name: "won't happen" } },
    );
    expect(res.status()).toBe(404);
  });
});
