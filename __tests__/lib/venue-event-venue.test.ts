/**
 * Which venue an event serves (src/lib/venue/event-venue.ts, D9): EHC's listed
 * slug, or saved rooms the event team opened; saved rooms win and are checked
 * walkable on every load.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

const { check } = vi.hoisted(() => ({ check: { ok: true, issues: [] as string[] } }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/venue/layout-check", () => ({ checkLayout: () => ({ ...check, openShare: {} }) }));

import { eventLayout, isVenueServed } from "@/lib/venue/event-venue";
import { TEMPLATES } from "@/lib/venue/rooms";

const withRooms = (extra: Record<string, unknown> = {}) => ({ venue: { rooms: { list: TEMPLATES.summit.rooms, updatedAt: 1, updatedBy: "u" }, ...extra } });
afterEach(() => { vi.unstubAllEnvs(); check.ok = true; check.issues = []; });

describe("isVenueServed", () => {
  it("serves a listed slug (EHC) whatever its settings", () => {
    vi.stubEnv("VENUE_EVENT_SLUGS", "ehc26");
    expect(isVenueServed({ slug: "ehc26", settings: {} })).toBe(true);
  });

  it("serves saved, opened rooms only while the module is on", () => {
    vi.stubEnv("VENUE_MODULE_ENABLED", "true");
    expect(isVenueServed({ slug: "x", settings: withRooms({ open: true }) })).toBe(true);
    expect(isVenueServed({ slug: "x", settings: withRooms({ open: false }) })).toBe(false);
    expect(isVenueServed({ slug: "x", settings: { venue: { open: true } } })).toBe(false);
    vi.stubEnv("VENUE_MODULE_ENABLED", "");
    expect(isVenueServed({ slug: "x", settings: withRooms({ open: true }) })).toBe(false);
  });
});

describe("eventLayout", () => {
  const event = (settings: unknown) => ({ id: "e1", name: "Summit", settings });

  it("generates the venue from saved rooms; EHC's preset otherwise", () => {
    vi.stubEnv("VENUE_MODULE_ENABLED", "true");
    const g = eventLayout(event(withRooms()));
    expect(g.kind).toBe("generated");
    expect(g.kind === "generated" && g.layout.zones.map((z) => z.id)).toContain("breakout-1");
    expect(eventLayout(event({})).kind).toBe("preset");
  });

  it("is broken, not served, when the saved rooms no longer make a walkable building", () => {
    vi.stubEnv("VENUE_MODULE_ENABLED", "true");
    check.ok = false;
    check.issues = ["Lounge cannot be reached from the entrance"];
    expect(eventLayout(event(withRooms()))).toEqual({ kind: "broken", issues: ["Lounge cannot be reached from the entrance"] });
  });
});
