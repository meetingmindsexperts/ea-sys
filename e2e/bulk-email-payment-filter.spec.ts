import { expect, test } from "@playwright/test";
import { loginAs, pickSelect } from "./fixtures/login";
import { EVENT_ID } from "./fixtures/seed-constants";

/**
 * W2-F4 — bulk email accepts a paymentStatus filter.
 *
 * Verifies the end-to-end UI flow: organizer opens the bulk email
 * dialog from the Communications page, sets the in-dialog Payment
 * status to UNPAID, fills required fields, and sends. We intercept
 * the POST to `/emails/bulk` (so no email actually goes out) and
 * assert the request body carries `filters.paymentStatus = "UNPAID"`.
 *
 * Without this fix the canonical "email all unpaid" workflow had to
 * over-send to all CONFIRMED registrations or fall back to external
 * tools — see Wave-2 verification report finding W2-F4.
 */

test("bulk email dialog forwards paymentStatus filter to /emails/bulk", async ({ page }) => {
  await loginAs(page, "ADMIN");

  // Capture the outbound POST so this spec doesn't actually email
  // anyone. The dialog hits `/emails/bulk` via a React Query
  // mutation — fulfill with a synthetic success response so the
  // dialog closes cleanly and onSuccess fires.
  let capturedPayload: unknown = null;
  await page.route(`**/api/events/${EVENT_ID}/emails/bulk`, async (route) => {
    capturedPayload = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        total: 0,
        successCount: 0,
        failureCount: 0,
        errors: [],
      }),
    });
  });

  await page.goto(`/events/${EVENT_ID}/communications`);

  const main = page.getByRole("main");

  // The Registrations audience card has a "Send Email" button — multiple
  // exist on the page (one per audience). It's the first card on the
  // page, so the first matching button is the registrations one.
  await main
    .getByRole("button", { name: /^send email$/i })
    .first()
    .click();

  // Inside the dialog: the new payment-status Select renders for
  // recipientType=registrations. Default is "All payment statuses";
  // pick UNPAID to exercise the W2-F4 contract.
  const dialog = page.getByRole("dialog");
  const paymentSelect = dialog.getByRole("combobox", { name: /payment status/i });
  await expect(paymentSelect).toBeVisible();
  await pickSelect(dialog, /payment status/i, "Unpaid");

  // emailType defaults to "confirmation" for registrations — that's
  // a template-driven send, no subject/message inputs to fill. We
  // only need to verify the new paymentStatusFilter rides the wire.
  // Send. Button text is "Send Emails" (plural) when sendMode === "now".
  await dialog.getByRole("button", { name: /^send emails$/i }).click();

  // Wait for the intercepted route to fire.
  await expect.poll(() => capturedPayload, { timeout: 10_000 }).not.toBeNull();

  const body = capturedPayload as {
    recipientType: string;
    filters?: { status?: string; paymentStatus?: string; ticketTypeId?: string };
  };
  expect(body.recipientType).toBe("registrations");
  // The contract under test — paymentStatus filter must be in the
  // payload. statusFilter and ticketTypeId are unrelated to W2-F4 and
  // intentionally NOT asserted here.
  expect(body.filters?.paymentStatus).toBe("UNPAID");
});
