import { expect, test } from "@playwright/test";
import { loginAs } from "./fixtures/login";

/**
 * An event that holds money cannot be deleted (review of 2b8a7b08, Nov 18, 2026).
 *
 * The delete route counts the event's invoices and payments and refuses when
 * there are any, because they are deleted with it. Those tables carry a row
 * policy, and the counts were made outside the tenant lane: under row security
 * both read 0, the guard let the delete through, and the financial records
 * went with the event. Nothing failed, so only a real request against a real
 * database shows it. This spec runs in the everyday suite and, where it
 * matters, under `npm run e2e:rls`.
 *
 * It makes its own event, so a guard that fails deletes nothing the other
 * specs need. The event stays behind afterwards: that is the guard working.
 */
test("an event with an invoice and a payment refuses to be deleted", async ({ page }) => {
  await loginAs(page, "ADMIN");
  const headers = { Origin: new URL(page.url()).origin };
  const stamp = Date.now();

  const created = await page.request.post("/api/events", {
    headers,
    data: { name: `Delete guard ${stamp}`, startDate: "2027-03-01T09:00:00.000Z", endDate: "2027-03-02T17:00:00.000Z" },
  });
  expect(created.status(), await created.text()).toBe(201);
  const { id: eventId } = (await created.json()) as { id: string };

  const type = await page.request.post(`/api/events/${eventId}/tickets`, {
    headers,
    data: { name: "Paid", pricingTiers: [{ name: "Standard", price: 100 }] },
  });
  expect(type.status(), await type.text()).toBe(201);
  const ticketType = (await type.json()) as { id: string; pricingTiers?: { id: string }[] };
  const pricingTierId = ticketType.pricingTiers?.[0]?.id;

  const registered = await page.request.post(`/api/events/${eventId}/registrations`, {
    headers,
    data: {
      ticketTypeId: ticketType.id,
      ...(pricingTierId ? { pricingTierId } : {}),
      attendee: { firstName: "Guard", lastName: "Check", email: `delete.guard.${stamp}@e2e.test` },
    },
  });
  expect(registered.status(), await registered.text()).toBe(201);
  const { id: registrationId } = (await registered.json()) as { id: string };

  // A recorded payment makes the invoice, the receipt and the payment row.
  const paid = await page.request.post(`/api/events/${eventId}/registrations/${registrationId}/payments`, {
    headers,
    data: { method: "cash", cashReceivedBy: "Delete guard spec" },
  });
  expect(paid.ok(), await paid.text()).toBeTruthy();

  const refused = await page.request.delete(`/api/events/${eventId}?confirm=true`, { headers });
  const body = (await refused.json()) as { code?: string; invoiceCount?: number; paymentCount?: number };
  expect(refused.status(), JSON.stringify(body)).toBe(409);
  expect(body.code).toBe("EVENT_HAS_FINANCIAL_RECORDS");
  expect(body.invoiceCount).toBeGreaterThan(0);
  expect(body.paymentCount).toBeGreaterThan(0);

  // And it is still there.
  expect((await page.request.get(`/api/events/${eventId}`)).status()).toBe(200);
});
