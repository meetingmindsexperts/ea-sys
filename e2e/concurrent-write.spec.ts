import { expect, test } from "@playwright/test";
import { loginAs } from "./fixtures/login";
import { EVENT_ID } from "./fixtures/seed-constants";

/**
 * W2-F8 — optimistic-lock guard on Registration + Speaker.
 *
 * The Wave-2 verification campaign reproduced silent last-write-wins on
 * concurrent `update_registration` calls. This spec pins the API
 * contract that closes that hazard:
 *
 *   1. PUT with `expectedUpdatedAt` matching the row's current value → 200.
 *   2. PUT with a STALE `expectedUpdatedAt` → 409 + code STALE_WRITE.
 *   3. PUT without `expectedUpdatedAt` → 200 (legacy fallback during rollout).
 *
 * Tests run via `page.request.put(...)` so they exercise the same
 * NextAuth-cookie-authenticated path the dashboard uses, but skip the
 * UI scaffolding — the dashboard's 409 handler is a thin toast +
 * refetch, not worth two-context Playwright complexity here.
 */

test.describe("optimistic locking on Registration", () => {
  test("stale expectedUpdatedAt → 409 STALE_WRITE; row is unchanged", async ({ page }) => {
    await loginAs(page, "ADMIN");

    // Look up the seeded REGISTRANT registration. seed-e2e.ts creates
    // one CONFIRMED + COMPLIMENTARY registration for registrant@test.local.
    const listRes = await page.request.get(`/api/events/${EVENT_ID}/registrations`);
    expect(listRes.ok()).toBeTruthy();
    const registrations = (await listRes.json()) as Array<{
      id: string;
      updatedAt: string;
      notes: string | null;
      attendee: { email: string };
    }>;
    const target = registrations.find((r) => r.attendee?.email === "registrant@test.local");
    expect(target, "seeded REGISTRANT registration must exist").toBeDefined();
    if (!target) throw new Error("seed missing");

    // Capture the read-time token so we can replay it as a stale write
    // after the first successful update bumps `updatedAt`.
    const readUpdatedAt = target.updatedAt;

    // 1. First PUT with the fresh token — succeeds. Returns the row
    //    with a NEW updatedAt that we deliberately discard.
    const fresh = await page.request.put(`/api/events/${EVENT_ID}/registrations/${target.id}`, {
      headers: { Origin: new URL(page.url()).origin },
      data: { notes: "concurrent-write spec — first edit", expectedUpdatedAt: readUpdatedAt },
    });
    expect(fresh.status()).toBe(200);
    const freshBody = (await fresh.json()) as { updatedAt: string; notes: string | null };
    expect(freshBody.notes).toBe("concurrent-write spec — first edit");
    // The row's updatedAt has advanced — readUpdatedAt is now stale.
    expect(freshBody.updatedAt).not.toBe(readUpdatedAt);

    // 2. Second PUT with the ORIGINAL (now stale) token — must be
    //    rejected with 409 STALE_WRITE. This is the W2-F8 contract.
    const stale = await page.request.put(`/api/events/${EVENT_ID}/registrations/${target.id}`, {
      headers: { Origin: new URL(page.url()).origin },
      data: { notes: "concurrent-write spec — stale edit (should NOT land)", expectedUpdatedAt: readUpdatedAt },
    });
    expect(stale.status()).toBe(409);
    const staleBody = (await stale.json()) as { code: string; error: string };
    expect(staleBody.code).toBe("STALE_WRITE");

    // 3. Verify the stale write did NOT overwrite the first edit.
    const verify = await page.request.get(`/api/events/${EVENT_ID}/registrations/${target.id}`);
    const verifyBody = (await verify.json()) as { notes: string | null };
    expect(verifyBody.notes).toBe("concurrent-write spec — first edit");
  });

  test("missing expectedUpdatedAt → legacy unconditional write succeeds", async ({ page }) => {
    // During rollout the field is OPTIONAL; missing token falls back to
    // the previous unconditional behaviour with a warn log so we can
    // audit which clients haven't migrated. This pins that fallback —
    // flipping it to "required" would silently break un-migrated callers.
    await loginAs(page, "ADMIN");

    const listRes = await page.request.get(`/api/events/${EVENT_ID}/registrations`);
    const registrations = (await listRes.json()) as Array<{ id: string; attendee: { email: string } }>;
    const target = registrations.find((r) => r.attendee?.email === "registrant@test.local");
    if (!target) throw new Error("seed missing");

    const res = await page.request.put(`/api/events/${EVENT_ID}/registrations/${target.id}`, {
      headers: { Origin: new URL(page.url()).origin },
      data: { notes: "legacy-path edit — no token" },
    });
    expect(res.status()).toBe(200);
  });
});
