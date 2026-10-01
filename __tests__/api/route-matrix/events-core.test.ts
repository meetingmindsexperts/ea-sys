/**
 * Route status matrix, domain 1 of the Phase 2 sweep: events core
 * (`/api/events` and `/api/events/[eventId]`). Recorded on the unswept code
 * (Oct 1, 2026); the sweep onto `requirePermission` must leave it byte for
 * byte unchanged. See ./harness.ts for what a cell means.
 *
 * Re-record ONLY when a change of behaviour is intended and reviewed:
 * `npx vitest run __tests__/api/route-matrix -u`, then read the diff.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db", async () => (await import("./harness")).dbModule);
vi.mock("@/lib/logger", async () => (await import("./harness")).loggerModule);
vi.mock("@/lib/auth", async () => ({ auth: (await import("./harness")).mockAuth }));
vi.mock("@/lib/api-key", async () => ({ validateApiKey: (await import("./harness")).mockValidateApiKey }));
// Side effects past the write never run (writes throw), but these load heavy clients at import.
vi.mock("@/lib/webinar-provisioner", () => ({ provisionWebinar: vi.fn() }));
vi.mock("@/lib/notifications", () => ({ notifyEventAdmins: vi.fn() }));

import { domainMatrix, type HandlerCase } from "./harness";
import { GET as listGET, POST as createPOST } from "@/app/api/events/route";
import { GET as eventGET, PUT as eventPUT, DELETE as eventDELETE } from "@/app/api/events/[eventId]/route";

const create = (eventType: string) => ({
  name: "Matrix event",
  eventType,
  startDate: "2027-01-10T00:00:00.000Z",
  endDate: "2027-01-11T00:00:00.000Z",
});

const CASES: HandlerCase[] = [
  { name: "GET /api/events", handler: listGET, method: "GET", perEvent: false },
  { name: "POST /api/events (CONFERENCE)", handler: createPOST, method: "POST", body: create("CONFERENCE"), perEvent: false },
  { name: "POST /api/events (WEBINAR)", handler: createPOST, method: "POST", body: create("WEBINAR"), perEvent: false },
  { name: "GET /api/events/[eventId]", handler: eventGET, method: "GET" },
  { name: "PUT /api/events/[eventId] (rename)", handler: eventPUT, method: "PUT", body: { name: "Renamed event" } },
  { name: "PUT /api/events/[eventId] (eventType CONFERENCE)", handler: eventPUT, method: "PUT", body: { eventType: "CONFERENCE" } },
  { name: "DELETE /api/events/[eventId]?confirm=true", handler: eventDELETE, method: "DELETE", query: "confirm=true" },
];

describe("route status matrix: events core", () => {
  it("matches the recorded matrix", async () => {
    await expect(await domainMatrix("events core", CASES)).toMatchFileSnapshot("./__snapshots__/events-core.matrix.txt");
  });
});
