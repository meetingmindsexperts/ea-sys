/**
 * An API key that acts with a role (custom roles Phase 5, plan §8.1; owner,
 * Oct 5, 2026: REST and MCP both). A key with no role stays the full system
 * row; a key with one holds exactly its grants.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockLoadEventFacts } = vi.hoisted(() => ({ mockLoadEventFacts: vi.fn() }));
vi.mock("@/lib/agent/event-facts-loader", () => ({ loadEventFacts: mockLoadEventFacts }));
vi.mock("@/lib/logger", () => ({ apiLogger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/db", () => ({ db: {} }));

import { can } from "@/lib/permissions/can";
import { principalFromApiKey } from "@/lib/permissions/require-permission";
import { gateMcpServerForKey } from "@/lib/agent/mcp-key-gate";

const conference = { organizationId: "org-1", eventType: "CONFERENCE", staffUserIds: [] };
const webinar = { organizationId: "org-1", eventType: "WEBINAR", staffUserIds: [] };

describe("the key's principal", () => {
  it("without a role is the full API key row", () => {
    const full = principalFromApiKey("org-1");
    expect(can(full, "registrations.update", { event: conference })).toBe(true);
    expect(principalFromApiKey("org-1", null).grants).toEqual(full.grants);
  });

  it("with a role holds exactly that role's grants", () => {
    const narrow = principalFromApiKey("org-1", [{ permission: "registrations.read", scope: "WEBINAR" }]);
    expect(narrow.fromApiKey).toBe(true);
    expect(can(narrow, "registrations.read", { event: webinar })).toBe(true);
    expect(can(narrow, "registrations.read", { event: conference })).toBe(false);
    expect(can(narrow, "registrations.delete", { event: webinar })).toBe(false);
  });

  it("with an archived role ([]) can do nothing", () => {
    expect(can(principalFromApiKey("org-1", []), "events.read")).toBe(false);
  });
});

describe("the MCP door for a key with a role", () => {
  beforeEach(() => vi.clearAllMocks());

  function fakeServer() {
    return { tool: vi.fn(), resource: vi.fn(), prompt: vi.fn() };
  }

  it("registers only the tools and resources the role holds somewhere", () => {
    const server = fakeServer();
    const gated = gateMcpServerForKey(server as never, principalFromApiKey("org-1", [{ permission: "speakers.read", scope: "ALL" }]), "org-1");
    gated.tool("list_speakers", "d", {}, async () => ({ content: [] }));
    gated.tool("create_speaker", "d", {}, async () => ({ content: [] }));
    gated.tool("not_mapped_tool", "d", {}, async () => ({ content: [] }));
    gated.resource("event-speakers", "uri", {}, async () => ({ contents: [] }));
    gated.resource("event-agenda", "uri", {}, async () => ({ contents: [] }));
    gated.prompt("p", "d", async () => ({ messages: [] }));
    expect(server.tool.mock.calls.map((c) => c[0])).toEqual(["list_speakers"]);
    expect(server.resource.mock.calls.map((c) => c[0])).toEqual(["event-speakers"]);
    expect(server.prompt).toHaveBeenCalledTimes(1);
  });

  it("judges each call on the event it names", async () => {
    const server = fakeServer();
    const run = vi.fn(async () => ({ content: [{ type: "text" as const, text: "ok" }] }));
    const gated = gateMcpServerForKey(server as never, principalFromApiKey("org-1", [{ permission: "speakers.read", scope: "WEBINAR" }]), "org-1");
    gated.tool("list_speakers", "d", {}, run);
    const wrapped = server.tool.mock.calls[0][3] as (input: unknown, extra: unknown) => Promise<{ isError?: boolean }>;

    mockLoadEventFacts.mockResolvedValueOnce(webinar);
    expect((await wrapped({ eventId: "w1" }, {})).isError).toBeUndefined();
    expect(run).toHaveBeenCalledTimes(1);

    mockLoadEventFacts.mockResolvedValueOnce(conference);
    expect((await wrapped({ eventId: "c1" }, {})).isError).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  // Phase 6 review (Oct 7, 2026): the role-keyed door gated each call but
  // returned results whole, so a role with registrations.read and no
  // finance.view / barcode.view read money and entry barcodes.
  it("removes money and barcodes from results for a role without those keys", async () => {
    const server = fakeServer();
    const payload = { registrations: [{ id: "r1", qrCode: "QR-1", totalPaid: 100, status: "CONFIRMED" }] };
    const run = vi.fn(async () => ({ content: [{ type: "text" as const, text: JSON.stringify(payload) }] }));
    const gated = gateMcpServerForKey(server as never, principalFromApiKey("org-1", [{ permission: "registrations.read", scope: "ALL" }]), "org-1");
    gated.tool("list_registrations", "d", {}, run);
    const wrapped = server.tool.mock.calls[0][3] as (input: unknown, extra: unknown) => Promise<{ content: { text: string }[] }>;
    mockLoadEventFacts.mockResolvedValueOnce(conference);
    const text = (await wrapped({ eventId: "c1" }, {})).content[0].text;
    expect(text).not.toContain("QR-1");
    expect(text).not.toContain("totalPaid");
    expect(text).toContain("CONFIRMED");
  });

  it("returns results whole when the role holds finance, barcodes and Zoom host", async () => {
    const server = fakeServer();
    const payload = { registrations: [{ id: "r1", qrCode: "QR-1" }] };
    const run = vi.fn(async () => ({ content: [{ type: "text" as const, text: JSON.stringify(payload) }] }));
    const grants = (["registrations.read", "finance.view", "barcode.view", "zoomHost.view"] as const).map((permission) =>
      permission === "registrations.read" ? { permission, scope: "ALL" as const } : { permission },
    );
    const gated = gateMcpServerForKey(server as never, principalFromApiKey("org-1", grants), "org-1");
    gated.tool("list_registrations", "d", {}, run);
    const wrapped = server.tool.mock.calls[0][3] as (input: unknown, extra: unknown) => Promise<{ content: { text: string }[] }>;
    mockLoadEventFacts.mockResolvedValueOnce(conference);
    expect((await wrapped({ eventId: "c1" }, {})).content[0].text).toBe(JSON.stringify(payload));
  });
});
