/**
 * cloneEventSettings — the allow-list that fixed cloning a WEBINAR event
 * (Aug 27, 2026). The clone used to spread settings wholesale, so it inherited
 * the SOURCE event's webinar anchor sessionId → 409 WEBINAR_ANCHOR_ONLY on
 * every Zoom attach. The allow-list drops the webinar anchor identity/state,
 * resets the staff-assignment lists, and drops unknown future keys, while
 * preserving every config/publish/deadline key the old copy carried.
 */
import { describe, it, expect } from "vitest";
import { cloneEventSettings } from "@/lib/event-clone-settings";

describe("cloneEventSettings", () => {
  it("drops the webinar anchor identity/state but keeps webinar config", () => {
    const out = cloneEventSettings({
      webinar: {
        sessionId: "anchor-from-SOURCE",
        autoCreated: true,
        provisioningAt: "2026-01-01T00:00:00Z",
        autoProvisionZoom: true,
        waitingRoom: false,
        autoRecording: "cloud",
        viewingMode: "hls",
      },
    });
    expect(out.webinar).toEqual({
      autoProvisionZoom: true,
      waitingRoom: false,
      autoRecording: "cloud",
      viewingMode: "hls",
    });
    // The bug this module exists to fix:
    expect((out.webinar as Record<string, unknown>).sessionId).toBeUndefined();
    expect((out.webinar as Record<string, unknown>).autoCreated).toBeUndefined();
    expect((out.webinar as Record<string, unknown>).provisioningAt).toBeUndefined();
  });

  it("resets staff-assignment lists to [] but preserves publish flags + deadlines (existing contract)", () => {
    const out = cloneEventSettings({
      reviewerUserIds: ["u1"],
      onsiteUserIds: ["u2"],
      agendaPublished: true,
      programmePublished: true,
      abstractDeadline: "2026-01-01",
      sessionProposalDeadline: "2026-01-02",
    });
    // Staff assignments never carry to a clone.
    expect(out.reviewerUserIds).toEqual([]);
    expect(out.onsiteUserIds).toEqual([]);
    // Publish flags + deadlines ARE preserved — clone.test.ts pins that
    // agendaPublished carries, and flipping that is a product call, not this fix.
    expect(out.agendaPublished).toBe(true);
    expect(out.programmePublished).toBe(true);
    expect(out.abstractDeadline).toBe("2026-01-01");
    expect(out.sessionProposalDeadline).toBe("2026-01-02");
  });

  it("keeps the config keys a clone should carry", () => {
    const src = {
      cme: { hours: 3 },
      groupRegistration: { enabled: true, minMembers: 2, maxMembers: 10 },
      maxAttendees: 500,
      registrationOpen: false,
      requireApproval: true,
      abstractPresentationTypes: ["ORAL", "POSTER"],
      notifyOnRegistration: false,
    };
    // Config keys copy verbatim; the clone additionally starts with empty staff.
    expect(cloneEventSettings(src)).toEqual({ ...src, reviewerUserIds: [], onsiteUserIds: [] });
  });

  it("DROPS an unknown/new key (allow-list fail-safe — the anti-deny-list property)", () => {
    const out = cloneEventSettings({
      cme: { hours: 3 },
      someBrandNewFeatureFlagNobodyListedYet: { live: "token" },
    });
    expect(out.cme).toBeDefined();
    expect(out).not.toHaveProperty("someBrandNewFeatureFlagNobodyListedYet");
  });

  it("no longer carries `sponsors`, which is a table now", () => {
    // Sponsors were promoted out of settings on Sep 2 2026 and the clone route
    // copies ROWS. Carrying the key too would give a clone a stale JSON copy
    // beside the real rows, which is the two-sources-of-truth state the
    // promotion exists to end. Pinned so nobody "restores" it while chasing a
    // clone that appears to lose its sponsors.
    const out = cloneEventSettings({ sponsors: [{ id: "s1", name: "Acme", sortOrder: 0 }] });
    expect(out).not.toHaveProperty("sponsors");
  });

  it("returns {} for a null / non-object / array source", () => {
    expect(cloneEventSettings(null)).toEqual({});
    expect(cloneEventSettings(undefined)).toEqual({});
    expect(cloneEventSettings("nope")).toEqual({});
    expect(cloneEventSettings(["nope"])).toEqual({});
  });

  it("omits webinar entirely when it carries only identity/state (no config)", () => {
    const out = cloneEventSettings({ webinar: { sessionId: "x", autoCreated: true } });
    expect(out).not.toHaveProperty("webinar");
  });
});
