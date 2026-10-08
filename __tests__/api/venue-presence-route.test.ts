/**
 * /api/venue/:eventId/presence (phase 5C) through the REAL venue gate: only
 * people who can walk the venue post or listen, a tab cannot be taken over,
 * the stream sends everyone else and takes the tab out when it closes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockAuth, mockDb } = vi.hoisted(() => ({ mockAuth: vi.fn(), mockDb: { event: { findFirst: vi.fn() } } }));

vi.mock("next/server", () => ({
  NextResponse: { json: (b: unknown, i?: { status?: number }) => ({ status: i?.status ?? 200, json: async () => b }) },
}));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/tenant-context", () => ({ runWithTenant: (_o: unknown, fn: () => unknown) => fn() }));

import { GET, POST } from "@/app/api/venue/[eventId]/presence/route";
import { peersFor, putPresence, resetPresenceForTests } from "@/lib/venue/presence-store";

const EVENT = { id: "evt-1", slug: "ehc26", name: "EHC", startDate: new Date(), endDate: new Date(), venue: null, timezone: "Asia/Dubai", eventType: "CONFERENCE", settings: {}, organizationId: "org-1", staffAssignments: [] };
const params = { params: Promise.resolve({ eventId: "evt-1" }) };
let n = 0;
const as = (name = "Wren") => {
  const id = `u-pres-${++n}`;
  mockAuth.mockResolvedValue({ user: { id, role: "MEMBER", organizationId: "org-1", name } });
  return id;
};
const post = (body: unknown) => POST(new Request("http://localhost/x", { method: "POST", body: JSON.stringify(body) }), params) as Promise<{ status: number; json: () => Promise<{ code?: string }> }>;

beforeEach(() => {
  vi.clearAllMocks();
  resetPresenceForTests();
  vi.stubEnv("VENUE_EVENT_SLUGS", "ehc26");
  mockDb.event.findFirst.mockResolvedValue(EVENT);
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /presence", () => {
  it("records this tab under the signed-in person, with their name", async () => {
    const me = as("Wren Writer");
    expect((await post({ peer: "tabaaaaaaaa", presence: { x: 3, by: "someone-else" } })).status).toBe(200);
    expect(peersFor("evt-1", "other", "u-x")[0]).toMatchObject({ peer: "tabaaaaaaaa", by: me, name: "Wren Writer", presence: { x: 3 } });
  });

  it("409 when another person's tab id is used; their avatar does not move", async () => {
    putPresence("evt-1", "tabaaaaaaaa", "u-owner", "Owner", { x: 1 });
    as();
    const res = await post({ peer: "tabaaaaaaaa", presence: { x: 60 } });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("TAB_TAKEN");
    expect(peersFor("evt-1", "other", "u-x")[0].presence.x).toBe(1);
  });

  it("leave removes only your own tab", async () => {
    putPresence("evt-1", "tabaaaaaaaa", "u-owner", "Owner", {});
    as();
    await post({ peer: "tabaaaaaaaa", leave: true });
    expect(peersFor("evt-1", "other", "u-x")).toHaveLength(1);
  });

  it("400 for a malformed tab id; 404 when the venue is not switched on", async () => {
    as();
    expect((await post({ peer: "../../etc", presence: {} })).status).toBe(400);
    vi.stubEnv("VENUE_EVENT_SLUGS", "");
    expect((await post({ peer: "tabaaaaaaaa", presence: {} })).status).toBe(404);
  });

  it("401 signed out", async () => {
    mockAuth.mockResolvedValue(null);
    expect((await post({ peer: "tabaaaaaaaa", presence: {} })).status).toBe(401);
  });
});

describe("GET /presence (the live stream)", () => {
  it("sends everyone in the venue, then takes this tab out when the stream closes", async () => {
    putPresence("evt-1", "tabcolleague", "u-col", "Lina", { x: 2 });
    const me = as();
    putPresence("evt-1", "tabmineaaaa", me, "Wren", { x: 1 });
    const ctl = new AbortController();
    const res = (await GET(new Request("http://localhost/x?peer=tabmineaaaa", { signal: ctl.signal }), params)) as unknown as Response;
    expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    const reader = res.body!.getReader();
    let text = "";
    while (!text.includes("data: ")) text += new TextDecoder().decode((await reader.read()).value);
    const data = JSON.parse(text.slice(text.indexOf("data: ") + 6).split("\n")[0]);
    expect(data.peers.map((p: { peer: string; sameTab: boolean; name: string }) => [p.peer, p.sameTab, p.name])).toEqual([["tabcolleague", false, "Lina"], ["tabmineaaaa", true, "Wren"]]);
    ctl.abort();
    await reader.cancel();
    expect(peersFor("evt-1", "x", "u-x").map((p) => p.peer)).toEqual(["tabcolleague"]);
  });

  it("400 without a valid tab id", async () => {
    as();
    expect(((await GET(new Request("http://localhost/x?peer=bad"), params)) as { status: number }).status).toBe(400);
  });

  it("at most 4 open streams a person", async () => {
    as();
    const open = [];
    for (let i = 0; i < 4; i++) open.push(new AbortController());
    const responses = [];
    for (let i = 0; i < 4; i++) responses.push(await GET(new Request(`http://localhost/x?peer=tabstream${i}aa`, { signal: open[i].signal }), params));
    expect(((await GET(new Request("http://localhost/x?peer=tabstream9aa"), params)) as { status: number }).status).toBe(429);
    for (let i = 0; i < 4; i++) {
      open[i].abort();
      await (responses[i] as unknown as Response).body!.cancel();
    }
    const again = new AbortController();
    const res = (await GET(new Request("http://localhost/x?peer=tabstream9aa", { signal: again.signal }), params)) as unknown as Response;
    expect(res.status).toBe(200);
    again.abort();
    await res.body!.cancel();
  });
});
