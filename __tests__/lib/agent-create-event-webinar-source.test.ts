/**
 * The agent's create_event and a webinar's video source (Nov 16, 2026). The source is fixed at
 * creation, so on a server that can run a partner's stream the agent must ASK: a webinar with no
 * source is refused with WEBINAR_SOURCE_REQUIRED and nothing is created. On a server that cannot,
 * Zoom is the only answer and nothing is asked; nor is anything asked of an API key, which keeps Zoom.
 */
import { readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockCreateEvent, partner } = vi.hoisted(() => ({
  mockCreateEvent: vi.fn(),
  partner: { ready: true },
}));

vi.mock("@/lib/db", () => ({ db: {}, dbOperator: {}, tenantTransaction: vi.fn() }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_org: string, fn: () => unknown) => fn() }));
vi.mock("@/lib/logger", () => ({
  apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  dbLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/services/event-service", () => ({ createEvent: mockCreateEvent }));
vi.mock("@/lib/webinar/partner-stream-readiness", () => ({
  partnerStreamReadiness: () => (partner.ready ? { ready: true, missing: [] } : { ready: false, missing: ["MEDIAMTX_CONTROL"] }),
}));

import { EVENT_EXECUTORS } from "@/lib/agent/tools/events";

const ctx = { eventId: "", organizationId: "org-1", userId: "user-1", source: "agent" as const, counters: { creates: 0, emailsSent: 0 } };
const create = (input: Record<string, unknown>) =>
  EVENT_EXECUTORS.create_event(
    { name: "Heart failure update", startDate: "2027-01-20T19:00:00+04:00", endDate: "2027-01-20T20:00:00+04:00", ...input },
    ctx,
  );

beforeEach(() => {
  vi.clearAllMocks();
  partner.ready = true;
  mockCreateEvent.mockResolvedValue({ ok: true, event: { id: "evt-1", name: "Heart failure update", eventType: "WEBINAR" } });
});

describe("create_event: a webinar's video source", () => {
  it("a webinar with no source is refused, so the agent asks, and nothing is created", async () => {
    const res = await create({ eventType: "WEBINAR" });
    expect(res).toMatchObject({ code: "WEBINAR_SOURCE_REQUIRED" });
    expect(String((res as { error: string }).error)).toMatch(/Ask the person/);
    expect(mockCreateEvent).not.toHaveBeenCalled();
  });

  it.each(["zoom", "external"])("the person's answer %s reaches the event service", async (webinarSource) => {
    await create({ eventType: "WEBINAR", webinarSource });
    expect(mockCreateEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: "WEBINAR", webinarSource }));
  });

  it("an unknown source is refused", async () => {
    expect(await create({ eventType: "WEBINAR", webinarSource: "teams" })).toMatchObject({ code: "INVALID_WEBINAR_SOURCE" });
    expect(mockCreateEvent).not.toHaveBeenCalled();
  });

  it("on a server that cannot run a partner's stream, a webinar is our Zoom and nothing is asked", async () => {
    partner.ready = false;
    await create({ eventType: "WEBINAR" });
    expect(mockCreateEvent).toHaveBeenCalledWith(expect.objectContaining({ webinarSource: "zoom" }));
  });

  it("an API key has no person to ask, so a webinar with no source stays our Zoom (review of 6f52fa22)", async () => {
    await EVENT_EXECUTORS.create_event(
      { name: "Automated webinar", startDate: "2027-01-20T19:00:00+04:00", endDate: "2027-01-20T20:00:00+04:00", eventType: "WEBINAR" },
      { ...ctx, source: "mcp", fromApiKey: true },
    );
    expect(mockCreateEvent).toHaveBeenCalledWith(expect.objectContaining({ webinarSource: "zoom" }));
  });

  it("the MCP door tells create_event whether a key is calling, and a key is the default actor", () => {
    const source = readFileSync("src/lib/agent/register-mcp-tools.ts", "utf8");
    const block = source.slice(source.indexOf('runTool("create_event"'), source.indexOf('runTool("create_event"') + 400);
    expect(block).toContain("fromApiKey: actor.fromApiKey");
    expect(source).toContain("options?.actor ?? { role: null, fromApiKey: true }");
  });

  it("a conference never carries a source", async () => {
    await create({ eventType: "CONFERENCE", webinarSource: "external" });
    expect(mockCreateEvent).toHaveBeenCalledWith(expect.objectContaining({ webinarSource: null }));
  });

  it("the system prompt tells the agent to ask on WEBINAR_SOURCE_REQUIRED and never pick for the person", () => {
    const source = readFileSync("src/lib/agent/system-prompt.ts", "utf8");
    expect(source).toContain("WEBINAR_SOURCE_REQUIRED");
    expect(source).toContain("Never pick one for them");
  });
});
