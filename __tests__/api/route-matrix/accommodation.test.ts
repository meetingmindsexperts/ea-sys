/**
 * Route status matrix, domain 6 of the Phase 2 sweep: accommodation (hotels,
 * room types, bookings). Recorded on the unswept code (Oct 2, 2026); the
 * sweep onto `requirePermission` must leave it byte for byte unchanged except
 * where a change is intended and reviewed. See ./harness.ts for what a cell
 * means.
 *
 * Re-record ONLY when a change of behaviour is intended and reviewed:
 * `npx vitest run __tests__/api/route-matrix -u`, then read the diff.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db", async () => (await import("./harness")).dbModule);
vi.mock("@/lib/logger", async () => (await import("./harness")).loggerModule);
vi.mock("@/lib/auth", async () => ({ auth: (await import("./harness")).mockAuth }));
vi.mock("@/lib/api-key", async () => ({
  validateApiKey: (await import("./harness")).mockValidateApiKey,
  apiKeyUseContext: () => ({}),
}));
vi.mock("@/lib/security", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/security")>()),
  checkRateLimit: () => ({ allowed: true, remaining: 1, retryAfterSeconds: 0 }),
}));

import { domainMatrix, type HandlerCase } from "./harness";
import { GET as hotelsGET, POST as hotelsPOST } from "@/app/api/events/[eventId]/hotels/route";
import { GET as hotelGET, PUT as hotelPUT, DELETE as hotelDELETE } from "@/app/api/events/[eventId]/hotels/[hotelId]/route";
import { GET as roomsGET, POST as roomsPOST } from "@/app/api/events/[eventId]/hotels/[hotelId]/rooms/route";
import { GET as roomGET, PUT as roomPUT, DELETE as roomDELETE } from "@/app/api/events/[eventId]/hotels/[hotelId]/rooms/[roomId]/route";
import { GET as accomsGET, POST as accomsPOST } from "@/app/api/events/[eventId]/accommodations/route";
import { GET as accomGET, PUT as accomPUT, DELETE as accomDELETE } from "@/app/api/events/[eventId]/accommodations/[accommodationId]/route";

const hotel = { hotelId: "h1" };
const room = { hotelId: "h1", roomId: "rt1" };
const accom = { accommodationId: "ac1" };

const CASES: HandlerCase[] = [
  { name: "GET hotels", handler: hotelsGET, method: "GET" },
  { name: "POST hotels", handler: hotelsPOST, method: "POST", body: { name: "Grand Hotel" } },
  { name: "GET hotels/[hotelId]", handler: hotelGET, method: "GET", params: hotel },
  { name: "PUT hotels/[hotelId]", handler: hotelPUT, method: "PUT", params: hotel, body: { name: "Grand Hotel 2" } },
  { name: "DELETE hotels/[hotelId]", handler: hotelDELETE, method: "DELETE", params: hotel },
  { name: "GET hotels/[hotelId]/rooms", handler: roomsGET, method: "GET", params: hotel },
  { name: "POST hotels/[hotelId]/rooms", handler: roomsPOST, method: "POST", params: hotel, body: { name: "Double", pricePerNight: 100, totalRooms: 10 } },
  { name: "GET hotels/[hotelId]/rooms/[roomId]", handler: roomGET, method: "GET", params: room },
  { name: "PUT hotels/[hotelId]/rooms/[roomId]", handler: roomPUT, method: "PUT", params: room, body: { name: "Twin" } },
  { name: "DELETE hotels/[hotelId]/rooms/[roomId]", handler: roomDELETE, method: "DELETE", params: room },
  { name: "GET accommodations", handler: accomsGET, method: "GET" },
  {
    name: "POST accommodations",
    handler: accomsPOST,
    method: "POST",
    body: { registrationId: "r1", roomTypeId: "rt1", checkIn: "2027-01-10T14:00:00.000Z", checkOut: "2027-01-12T11:00:00.000Z" },
  },
  { name: "GET accommodations/[accommodationId]", handler: accomGET, method: "GET", params: accom },
  { name: "PUT accommodations/[accommodationId]", handler: accomPUT, method: "PUT", params: accom, body: { specialRequests: "Late check-in" } },
  { name: "DELETE accommodations/[accommodationId]", handler: accomDELETE, method: "DELETE", params: accom },
];

describe("route status matrix: accommodation", () => {
  it("matches the recorded matrix", async () => {
    await expect(await domainMatrix("accommodation", CASES)).toMatchFileSnapshot("./__snapshots__/accommodation.matrix.txt");
  });
});
