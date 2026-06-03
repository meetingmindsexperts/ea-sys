import { expect, test } from "@playwright/test";
import { loginAs } from "./fixtures/login";
import { EVENT_ID } from "./fixtures/seed-constants";

/**
 * E2E coverage for the certificates operator-feedback round (2026-06-03):
 *   - GET  /api/events/[eventId]/certificates/issued     (listing route)
 *   - POST /api/events/[eventId]/certificates/issued/[id]/resend
 *
 * Scoped to the API contract surfaces — auth / RBAC / org binding /
 * XOR-id requirement / empty-result handling. UI-level coverage of the
 * resend button is not attempted because the e2e seed does not create
 * IssuedCertificate rows (those are only produced by the cron worker
 * which has its own unit suite). When the seed gains a cert row, the
 * dashboard-side tests at the bottom of this file can light up — the
 * stubs are left commented in to make that future patch surgical.
 *
 * Mirrors the API-level pattern in `e2e/certificates.spec.ts` rather
 * than trying to drive the canvas editor + react-rnd through Playwright
 * (per that file's preamble — too brittle for E2E).
 */

test.describe("certificates resend — listing route", () => {
  test("ADMIN: GET requires registrationId OR speakerId", async ({ page }) => {
    await loginAs(page, "ADMIN");

    const res = await page.request.get(
      `/api/events/${EVENT_ID}/certificates/issued`,
    );
    expect(res.status()).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/registrationId or speakerId/i);
  });

  test("ADMIN: GET rejects BOTH ids at once (prevents accidental cross-reference)", async ({ page }) => {
    await loginAs(page, "ADMIN");

    const res = await page.request.get(
      `/api/events/${EVENT_ID}/certificates/issued?registrationId=foo&speakerId=bar`,
    );
    expect(res.status()).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/not both/i);
  });

  test("ADMIN: empty result for registrant with no certs returns [] not 404", async ({ page }) => {
    await loginAs(page, "ADMIN");

    // Use a known-empty id. The e2e seed doesn't issue certs, so even
    // a real registration id returns []. Stable behavior.
    const res = await page.request.get(
      `/api/events/${EVENT_ID}/certificates/issued?registrationId=e2e-no-such-reg`,
    );
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { certificates: unknown[] };
    expect(Array.isArray(body.certificates)).toBe(true);
    expect(body.certificates).toHaveLength(0);
  });

  test("REVIEWER: GET refused (denyReviewer guard)", async ({ page }) => {
    await loginAs(page, "REVIEWER");

    const res = await page.request.get(
      `/api/events/${EVENT_ID}/certificates/issued?registrationId=foo`,
    );
    expect(res.status()).toBe(403);
  });

  test("ADMIN: cross-tenant event returns 404 (non-enumeration)", async ({ page }) => {
    await loginAs(page, "ADMIN");

    // Made-up eventId not bound to this org. 404 not 403 by design —
    // 403 would confirm the resource exists on a different org.
    const res = await page.request.get(
      `/api/events/some-foreign-event/certificates/issued?registrationId=anything`,
    );
    expect(res.status()).toBe(404);
  });
});

test.describe("certificates resend — POST resend", () => {
  test("ADMIN: resend on a non-existent cert returns 404", async ({ page }) => {
    await loginAs(page, "ADMIN");

    const res = await page.request.post(
      `/api/events/${EVENT_ID}/certificates/issued/no-such-cert/resend`,
    );
    expect(res.status()).toBe(404);
  });

  test("REVIEWER: POST refused (denyReviewer guard)", async ({ page }) => {
    await loginAs(page, "REVIEWER");

    const res = await page.request.post(
      `/api/events/${EVENT_ID}/certificates/issued/anything/resend`,
    );
    expect(res.status()).toBe(403);
  });

  test("ADMIN: cross-tenant cert returns 404", async ({ page }) => {
    await loginAs(page, "ADMIN");

    const res = await page.request.post(
      `/api/events/some-foreign-event/certificates/issued/anything/resend`,
    );
    expect(res.status()).toBe(404);
  });
});

// --- Future coverage when the seed gains an IssuedCertificate row ---
// test("ADMIN: full resend round-trip bumps counter + writes EmailLog row", async ({ page }) => {
//   await loginAs(page, "ADMIN");
//   const certId = "<seeded-issued-cert-id>";
//   const before = await page.request.get(
//     `/api/events/${EVENT_ID}/certificates/issued?registrationId=<seeded-reg-id>`,
//   );
//   const { certificates: [pre] } = await before.json();
//   expect(pre.resendCount).toBe(0);
//
//   const resend = await page.request.post(
//     `/api/events/${EVENT_ID}/certificates/issued/${certId}/resend`,
//   );
//   expect(resend.status()).toBe(200);
//   const result = await resend.json();
//   expect(result.resendCount).toBe(1);
//
//   // EmailLog row with templateSlug discriminator should now exist.
//   const logs = await page.request.get(
//     `/api/email-logs?entityType=REGISTRATION&entityId=<seeded-reg-id>`,
//   );
//   const { logs: rows } = await logs.json();
//   expect(rows.some((r: { templateSlug: string }) => r.templateSlug === "certificate-delivery")).toBe(true);
// });
