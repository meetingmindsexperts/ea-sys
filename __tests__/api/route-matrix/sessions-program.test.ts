/**
 * Route status matrix, domain 3 of the Phase 2 sweep: sessions and tracks
 * (the agenda). Recorded on the unswept code (Oct 2, 2026); the sweep onto
 * `requirePermission` must leave it byte for byte unchanged. See ./harness.ts
 * for what a cell means. The session Zoom routes belong to the webinar domain.
 *
 * The session list GET is the first matrix route that also takes an API key
 * (`getOrgContext`), so the API_KEY row is real here, and the attendee-side
 * roles reach the GETs through their linked events.
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
// The bulk delete's per-user budget would turn later cells into 429s; the
// matrix is about who gets in, not about the limiter.
vi.mock("@/lib/security", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/security")>()),
  checkRateLimit: () => ({ allowed: true, remaining: 1, retryAfterSeconds: 0 }),
}));

import { domainMatrix, type HandlerCase } from "./harness";
import { GET as sessionsGET, POST as sessionsPOST } from "@/app/api/events/[eventId]/sessions/route";
import { GET as sessionGET, PUT as sessionPUT, DELETE as sessionDELETE } from "@/app/api/events/[eventId]/sessions/[sessionId]/route";
import { POST as bulkDeletePOST } from "@/app/api/events/[eventId]/sessions/bulk-delete/route";
import { GET as tracksGET, POST as tracksPOST } from "@/app/api/events/[eventId]/tracks/route";
import { GET as trackGET, PUT as trackPUT, DELETE as trackDELETE } from "@/app/api/events/[eventId]/tracks/[trackId]/route";

const session = { sessionId: "s1" };
const track = { trackId: "t1" };

const CASES: HandlerCase[] = [
  { name: "GET sessions", handler: sessionsGET, method: "GET" },
  {
    name: "POST sessions",
    handler: sessionsPOST,
    method: "POST",
    body: { name: "Opening", startTime: "2027-01-10T09:00:00.000Z", endTime: "2027-01-10T10:00:00.000Z" },
  },
  { name: "GET sessions/[sessionId]", handler: sessionGET, method: "GET", params: session },
  { name: "PUT sessions/[sessionId]", handler: sessionPUT, method: "PUT", params: session, body: { name: "Opening 2" } },
  { name: "DELETE sessions/[sessionId]", handler: sessionDELETE, method: "DELETE", params: session },
  { name: "POST sessions/bulk-delete", handler: bulkDeletePOST, method: "POST", body: { sessionIds: ["s1"] } },
  { name: "GET tracks", handler: tracksGET, method: "GET" },
  { name: "POST tracks", handler: tracksPOST, method: "POST", body: { name: "Track A" } },
  { name: "GET tracks/[trackId]", handler: trackGET, method: "GET", params: track },
  { name: "PUT tracks/[trackId]", handler: trackPUT, method: "PUT", params: track, body: { name: "Track B" } },
  { name: "DELETE tracks/[trackId]", handler: trackDELETE, method: "DELETE", params: track },
];

describe("route status matrix: sessions and tracks", () => {
  it("matches the recorded matrix", async () => {
    await expect(await domainMatrix("sessions and tracks", CASES)).toMatchFileSnapshot(
      "./__snapshots__/sessions-program.matrix.txt",
    );
  });
});
