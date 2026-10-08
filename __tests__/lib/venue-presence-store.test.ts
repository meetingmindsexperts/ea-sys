/**
 * presence-store (phase 5C): where everyone is in an event's venue, in
 * memory. A tab can only move its own avatar, values are reshaped to the
 * venue's ranges, people drop out 15 seconds after their last update, and the
 * caps (4 tabs a person, 200 an event) hold.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  MAX_PEERS_PER_EVENT, MAX_TABS_PER_PERSON, PRESENCE_TTL_MS, leavePresence, peersFor, presenceVersion, putPresence, resetPresenceForTests, shapePresence,
} from "@/lib/venue/presence-store";

const T0 = 1_000_000;
beforeEach(() => resetPresenceForTests());

describe("shapePresence", () => {
  it("clamps positions to the venue and drops anything it cannot show", () => {
    expect(shapePresence({ x: 9999, z: -9999, y: 1.23456, yaw: 2, mv: -1, zn: "<script>", col: "red", g: "dance", gt: 3.7, sn: -2, say: "x".repeat(400), extra: "kept out" })).toEqual({
      v: 1, x: 70, z: -44, y: 1.23, yaw: 2, mv: 0, zn: "", col: "", g: "", gt: 3, sn: 0, say: "x".repeat(280),
    });
    expect(shapePresence({ zn: "plenary", col: "#2E9E6B", g: "wave" })).toMatchObject({ zn: "plenary", col: "#2E9E6B", g: "wave" });
    expect(shapePresence("nonsense")).toMatchObject({ v: 1, x: 0, z: 26 });
  });
});

describe("tabs and people", () => {
  it("shows each viewer everyone, marking their own tab and their other tabs", () => {
    putPresence("e1", "tabaaaaaaaa", "u-1", "Wren", { x: 1 }, T0);
    putPresence("e1", "tabbbbbbbbb", "u-1", "Wren", { x: 2 }, T0);
    putPresence("e1", "tabcccccccc", "u-2", "Lina", { x: 3 }, T0);
    const seen = peersFor("e1", "tabaaaaaaaa", "u-1", T0);
    expect(seen.map((p) => [p.peer, p.by, p.name, p.isMe, p.sameTab])).toEqual([
      ["tabaaaaaaaa", "u-1", "Wren", true, true],
      ["tabbbbbbbbb", "u-1", "Wren", true, false],
      ["tabcccccccc", "u-2", "Lina", false, false],
    ]);
    expect(peersFor("e2", "tabaaaaaaaa", "u-1", T0)).toEqual([]); // another event's venue is separate
  });

  it("a tab can only be moved, or removed, by the person it belongs to", () => {
    putPresence("e1", "tabaaaaaaaa", "u-1", "Wren", { x: 1 }, T0);
    expect(putPresence("e1", "tabaaaaaaaa", "u-2", "Mallory", { x: 50 }, T0)).toEqual({ ok: false, code: "TAB_TAKEN" });
    leavePresence("e1", "tabaaaaaaaa", "u-2");
    expect(peersFor("e1", "x", "u-3", T0)[0]).toMatchObject({ by: "u-1", presence: { x: 1 } });
    leavePresence("e1", "tabaaaaaaaa", "u-1");
    expect(peersFor("e1", "x", "u-3", T0)).toEqual([]);
  });

  it(`at most ${MAX_TABS_PER_PERSON} tabs a person and ${MAX_PEERS_PER_EVENT} people an event`, () => {
    for (let i = 0; i < MAX_TABS_PER_PERSON; i++) expect(putPresence("e1", `tabuser${i}aaaa`, "u-1", "", {}, T0).ok).toBe(true);
    expect(putPresence("e1", "tabuser9aaaa", "u-1", "", {}, T0)).toEqual({ ok: false, code: "TOO_MANY_TABS" });
    expect(putPresence("e1", "tabuser0aaaa", "u-1", "", { x: 5 }, T0).ok).toBe(true); // an existing tab still moves
    for (let i = MAX_TABS_PER_PERSON; i < MAX_PEERS_PER_EVENT; i++) putPresence("e1", `tabpeople${i}`, `u-p${i}`, "", {}, T0);
    expect(putPresence("e1", "tablatecomer", "u-late", "", {}, T0)).toEqual({ ok: false, code: "VENUE_FULL" });
  });

  it("drops a tab 15 seconds after its last update, and counts every change", () => {
    const v0 = presenceVersion("e1", T0);
    putPresence("e1", "tabaaaaaaaa", "u-1", "", {}, T0);
    const v1 = presenceVersion("e1", T0);
    expect(v1).toBeGreaterThan(v0);
    expect(peersFor("e1", "x", "u-2", T0 + PRESENCE_TTL_MS)).toHaveLength(1);
    expect(peersFor("e1", "x", "u-2", T0 + PRESENCE_TTL_MS + 1)).toHaveLength(0);
    expect(presenceVersion("e1", T0 + PRESENCE_TTL_MS + 1)).toBeGreaterThan(v1);
  });
});
