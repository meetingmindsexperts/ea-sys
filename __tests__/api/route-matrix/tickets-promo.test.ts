/**
 * Route status matrix, domain 2 of the Phase 2 sweep: registration types,
 * pricing tiers and promo codes. Recorded on the unswept code (Oct 1, 2026);
 * the sweep onto `requirePermission` must leave it byte for byte unchanged.
 * See ./harness.ts for what a cell means.
 *
 * The ticket, tier and promo rows themselves read as absent (the harness
 * answers every non-event read with nothing), so a caller who passes the
 * guard and reaches the event lands on the handler's own 404 or 400. The
 * `r` marker is what separates that from an event-lookup 404.
 *
 * Re-record ONLY when a change of behaviour is intended and reviewed:
 * `npx vitest run __tests__/api/route-matrix -u`, then read the diff.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db", async () => (await import("./harness")).dbModule);
vi.mock("@/lib/logger", async () => (await import("./harness")).loggerModule);
vi.mock("@/lib/auth", async () => ({ auth: (await import("./harness")).mockAuth }));
vi.mock("@/lib/api-key", async () => ({ validateApiKey: (await import("./harness")).mockValidateApiKey }));

import { domainMatrix, type HandlerCase } from "./harness";
import { GET as ticketsGET, POST as ticketsPOST } from "@/app/api/events/[eventId]/tickets/route";
import { GET as ticketGET, PUT as ticketPUT, DELETE as ticketDELETE } from "@/app/api/events/[eventId]/tickets/[ticketId]/route";
import { POST as tiersPOST } from "@/app/api/events/[eventId]/tickets/[ticketId]/tiers/route";
import { PUT as tierPUT, DELETE as tierDELETE } from "@/app/api/events/[eventId]/tickets/[ticketId]/tiers/[tierId]/route";
import { GET as promosGET, POST as promosPOST } from "@/app/api/events/[eventId]/promo-codes/route";
import { GET as promoGET, PUT as promoPUT, DELETE as promoDELETE } from "@/app/api/events/[eventId]/promo-codes/[promoCodeId]/route";

const ticket = { ticketId: "tt1" };
const tier = { ticketId: "tt1", tierId: "tier1" };
const promo = { promoCodeId: "pc1" };

const CASES: HandlerCase[] = [
  { name: "GET tickets", handler: ticketsGET, method: "GET" },
  { name: "POST tickets", handler: ticketsPOST, method: "POST", body: { name: "Delegate" } },
  { name: "GET tickets/[ticketId]", handler: ticketGET, method: "GET", params: ticket },
  { name: "PUT tickets/[ticketId]", handler: ticketPUT, method: "PUT", params: ticket, body: { name: "Delegate 2" } },
  { name: "DELETE tickets/[ticketId]", handler: ticketDELETE, method: "DELETE", params: ticket },
  { name: "POST tickets/[ticketId]/tiers", handler: tiersPOST, method: "POST", params: ticket, body: { name: "Early", price: 100 } },
  { name: "PUT tickets/[ticketId]/tiers/[tierId]", handler: tierPUT, method: "PUT", params: tier, body: { name: "Late" } },
  { name: "DELETE tickets/[ticketId]/tiers/[tierId]", handler: tierDELETE, method: "DELETE", params: tier },
  { name: "GET promo-codes", handler: promosGET, method: "GET" },
  { name: "POST promo-codes", handler: promosPOST, method: "POST", body: { code: "SAVE10", discountType: "PERCENTAGE", discountValue: 10 } },
  { name: "GET promo-codes/[promoCodeId]", handler: promoGET, method: "GET", params: promo },
  { name: "PUT promo-codes/[promoCodeId]", handler: promoPUT, method: "PUT", params: promo, body: { description: "x" } },
  { name: "DELETE promo-codes/[promoCodeId]", handler: promoDELETE, method: "DELETE", params: promo },
];

describe("route status matrix: registration types and promo codes", () => {
  it("matches the recorded matrix", async () => {
    await expect(await domainMatrix("registration types and promo codes", CASES)).toMatchFileSnapshot(
      "./__snapshots__/tickets-promo.matrix.txt",
    );
  });
});
