/**
 * One registration serves both doors (architecture review §4.2). The
 * registry runs registerAllMcpTools against a recording stub, so the tools
 * the in-app Event Agent offers are exactly the tools the MCP door offers
 * the same actor, with the JSON schema derived from the Zod shape and the
 * actor's user id and the door stamped onto the executor context.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockExec, mockEventFindFirst } = vi.hoisted(() => ({
  mockExec: vi.fn(),
  mockEventFindFirst: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: { event: { findFirst: mockEventFindFirst } },
  dbOperator: {},
}));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/agent/event-tools", () => ({
  TOOL_EXECUTOR_MAP: { create_track: mockExec, create_event: mockExec, list_tracks: mockExec },
}));

import { collectToolsForActor, inputSchemaFromShape, toAnthropicTool } from "@/lib/agent/tool-registry";
import { z } from "zod";

const actor = (role: string) => ({ userId: "u1", role, fromApiKey: false });
const collect = (role: string, source: "agent" | "mcp" = "agent") =>
  collectToolsForActor({ organizationId: "org1", actor: actor(role), source });

describe("collectToolsForActor", () => {
  beforeEach(() => {
    mockExec.mockReset();
    mockExec.mockResolvedValue({ success: true });
    mockEventFindFirst.mockReset();
    mockEventFindFirst.mockResolvedValue({ organizationId: "org1" });
  });

  it("gives an admin the org-level tools, the event tools and the CRM tools", () => {
    const names = collect("ADMIN").map((t) => t.name);
    for (const n of ["create_event", "list_events", "search_event", "update_event", "list_contacts", "update_contact"]) {
      expect(names, n).toContain(n);
    }
    for (const n of ["create_track", "create_registration", "send_bulk_email", "list_zoom_meetings", "create_zoom_meeting"]) {
      expect(names, n).toContain(n);
    }
    expect(names).toContain("list_crm_deals");
    expect(names).toContain("create_crm_deal");
    expect(new Set(names).size, "no duplicate names").toBe(names.length);
  });

  it("applies the CRM door's own role rules: MEMBER reads the board, WEBINARS never sees it", () => {
    const member = collect("MEMBER").map((t) => t.name);
    expect(member).toContain("list_crm_deals");
    expect(member).not.toContain("create_crm_deal");
    const webinars = collect("WEBINARS").map((t) => t.name);
    expect(webinars.some((n) => n.includes("crm"))).toBe(false);
  });

  it("puts eventId on every event tool's schema and nothing on the org-level list tool", () => {
    const tools = collect("ADMIN");
    const track = tools.find((t) => t.name === "create_track")!;
    expect(track.inputSchema.type).toBe("object");
    const props = track.inputSchema.properties as Record<string, unknown>;
    expect(props.eventId).toBeDefined();
    expect(track.inputSchema.required).toContain("eventId");
    const events = tools.find((t) => t.name === "list_events")!;
    expect((events.inputSchema.properties as Record<string, unknown>).eventId).toBeUndefined();
    const anthropic = toAnthropicTool(track);
    expect(anthropic).toEqual({ name: "create_track", description: track.description, input_schema: track.inputSchema });
    expect(JSON.stringify(anthropic)).not.toContain("$schema");
  });

  it("runs an event tool with the actor's id and the door as source, after binding the event to the org", async () => {
    const track = collect("ADMIN", "agent").find((t) => t.name === "create_track")!;
    const out = await track.run({ eventId: "ev1", name: "Cardiology" });
    expect(out.isError).toBe(false);
    expect(mockEventFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "ev1", organizationId: "org1" } }),
    );
    expect(mockExec).toHaveBeenCalledTimes(1);
    const [input, ctx] = mockExec.mock.calls[0];
    expect(input).toEqual({ name: "Cardiology" });
    expect(ctx).toMatchObject({ eventId: "ev1", organizationId: "org1", userId: "u1", source: "agent" });
  });

  it("stamps mcp when collected for the MCP door", async () => {
    const track = collect("ADMIN", "mcp").find((t) => t.name === "create_track")!;
    await track.run({ eventId: "ev1", name: "T" });
    expect(mockExec.mock.calls[0][1]).toMatchObject({ source: "mcp", userId: "u1" });
  });

  it("refuses an event outside the org as an error result, never a throw", async () => {
    mockEventFindFirst.mockResolvedValue(null);
    const track = collect("ADMIN").find((t) => t.name === "create_track")!;
    const out = await track.run({ eventId: "other", name: "T" });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/not found or access denied/);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("validates the model's input the way the SDK would", async () => {
    const track = collect("ADMIN").find((t) => t.name === "create_track")!;
    const out = await track.run({ eventId: 5 });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/Invalid input for create_track/);
    expect(mockExec).not.toHaveBeenCalled();
  });
});

describe("inputSchemaFromShape", () => {
  it("keeps descriptions, enums and required fields", () => {
    const schema = inputSchemaFromShape({
      eventId: z.string().describe("Event ID"),
      status: z.enum(["A", "B"]).optional(),
    });
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["eventId"]);
    const props = schema.properties as Record<string, { description?: string; enum?: string[] }>;
    expect(props.eventId.description).toBe("Event ID");
    expect(props.status.enum).toEqual(["A", "B"]);
  });
});

describe("approval on the MCP registrations", () => {
  beforeEach(() => {
    mockExec.mockReset();
    mockExec.mockResolvedValue({ success: true });
    mockEventFindFirst.mockReset();
    mockEventFindFirst.mockResolvedValue({ organizationId: "org1" });
  });

  it("an approval-required tool answers APPROVAL_REQUIRED until confirm is true, and never passes confirm on", async () => {
    const tools = collect("ADMIN");
    const del = tools.find((t) => t.name === "delete_promo_code")!;
    expect((del.inputSchema.properties as Record<string, unknown>).confirm).toBeDefined();
    const first = await del.run({ eventId: "ev1", promoCodeId: "p1" });
    expect(first.text).toContain("APPROVAL_REQUIRED");
    expect(mockEventFindFirst).not.toHaveBeenCalled();
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("an ordinary write has no confirm parameter and runs at once", async () => {
    const track = collect("ADMIN").find((t) => t.name === "create_track")!;
    expect((track.inputSchema.properties as Record<string, unknown>).confirm).toBeUndefined();
    await track.run({ eventId: "ev1", name: "T" });
    expect(mockExec).toHaveBeenCalledTimes(1);
  });

  it("the in-app model never sees the confirm parameter", () => {
    const del = collect("ADMIN").find((t) => t.name === "delete_promo_code")!;
    const anthropic = toAnthropicTool(del);
    expect((anthropic.input_schema.properties as Record<string, unknown>).confirm).toBeUndefined();
    expect(anthropic.input_schema.required).not.toContain("confirm");
  });
});
