/**
 * Route status matrix, domain 5 part B of the Phase 2 sweep: the abstract and
 * session proposal routes where the outside identities write as well as
 * staff (an author submits and edits their own abstract or proposal, a
 * reviewer scores, the submitter context and profile). Recorded on the unswept
 * code (Oct 2, 2026); the sweep onto `requirePermission` must leave it byte
 * for byte unchanged. See ./harness.ts for what a cell means.
 *
 * This file opts into the harness's rows (`useFixtureRows`): abstract `ab1`
 * and proposal `pr1` exist on every fixture event, authored by the SUBMITTER
 * caller's speaker row, and the REVIEWER caller is assigned to `ab1`. So the
 * rules that come after the event (own abstract only, assigned reviewer only)
 * show in the cells, not just who reaches the event.
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

import { domainMatrix, useFixtureRows, type HandlerCase } from "./harness";
import { GET as abstractsGET, POST as abstractsPOST } from "@/app/api/events/[eventId]/abstracts/route";
import { GET as abstractGET, PUT as abstractPUT, DELETE as abstractDELETE } from "@/app/api/events/[eventId]/abstracts/[abstractId]/route";
import { GET as submissionsGET, POST as submissionsPOST } from "@/app/api/events/[eventId]/abstracts/[abstractId]/submissions/route";
import { GET as myProfileGET, PATCH as myProfilePATCH } from "@/app/api/events/[eventId]/abstracts/my-profile/route";
import { GET as proposalsGET, POST as proposalsPOST } from "@/app/api/events/[eventId]/session-proposals/route";
import { GET as proposalGET, PUT as proposalPUT, DELETE as proposalDELETE } from "@/app/api/events/[eventId]/session-proposals/[proposalId]/route";
import { GET as submitterContextGET } from "@/app/api/events/[eventId]/submitter-context/route";

const abs = { abstractId: "ab1" };
const prop = { proposalId: "pr1" };

const CASES: HandlerCase[] = [
  { name: "GET abstracts", handler: abstractsGET, method: "GET" },
  { name: "POST abstracts", handler: abstractsPOST, method: "POST", body: { speakerId: "sp1", title: "A study", content: "Body text", presentationType: "ORAL" } },
  { name: "GET abstracts/[abstractId]", handler: abstractGET, method: "GET", params: abs },
  { name: "PUT abstracts/[abstractId]", handler: abstractPUT, method: "PUT", params: abs, body: { title: "A study, revised" } },
  { name: "PUT abstracts/[abstractId] (review status only)", handler: abstractPUT, method: "PUT", params: abs, body: { status: "UNDER_REVIEW" } },
  { name: "DELETE abstracts/[abstractId]", handler: abstractDELETE, method: "DELETE", params: abs },
  { name: "GET abstracts/[abstractId]/submissions", handler: submissionsGET, method: "GET", params: abs },
  { name: "POST abstracts/[abstractId]/submissions", handler: submissionsPOST, method: "POST", params: abs, body: { overallScore: 70 } },
  { name: "GET abstracts/my-profile", handler: myProfileGET, method: "GET" },
  { name: "PATCH abstracts/my-profile", handler: myProfilePATCH, method: "PATCH", body: { firstName: "Renamed" } },
  { name: "GET session-proposals", handler: proposalsGET, method: "GET" },
  { name: "POST session-proposals", handler: proposalsPOST, method: "POST", body: { speakerId: "sp1", title: "A workshop", description: "What it covers" } },
  { name: "GET session-proposals/[proposalId]", handler: proposalGET, method: "GET", params: prop },
  { name: "PUT session-proposals/[proposalId]", handler: proposalPUT, method: "PUT", params: prop, body: { title: "A workshop, revised" } },
  { name: "DELETE session-proposals/[proposalId]", handler: proposalDELETE, method: "DELETE", params: prop },
  { name: "GET submitter-context", handler: submitterContextGET, method: "GET" },
];

describe("route status matrix: abstracts and proposals, author and reviewer side", () => {
  it("matches the recorded matrix", async () => {
    useFixtureRows();
    await expect(await domainMatrix("abstracts and proposals, author and reviewer side", CASES)).toMatchFileSnapshot(
      "./__snapshots__/abstracts-authors.matrix.txt",
    );
  });
});
