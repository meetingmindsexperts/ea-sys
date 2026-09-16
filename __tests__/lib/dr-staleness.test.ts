/**
 * describeDrStaleness — what a stale DR stream actually MEANS (Sep 16, 2026).
 *
 * The incident this exists for: one 9.5MB object failed on s3:GetObjectTagging
 * every hour, `aws s3 sync` exited non-zero, the `&&` never wrote the
 * heartbeat, and every smaller file kept mirroring fine. The digest reported
 * only "newest is 11h old", which reads as a dead mirror. The load-bearing
 * property here is that objects-arriving-while-the-heartbeat-is-frozen is
 * called out as a FAILING SYNC and points at the cron log, because that is the
 * difference between looking at the right thing and the wrong thing at 3am.
 */
import { describe, it, expect } from "vitest";
import { describeDrStaleness, type DrStalenessInput } from "@/lib/infra/dr-staleness";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-09-16T05:39:00.000Z");
const ago = (hours: number) => new Date(NOW - hours * HOUR).toISOString();

function row(over: Partial<DrStalenessInput> = {}): DrStalenessInput {
  return {
    prefix: "uploads/",
    latestAt: ago(11.6),
    ageHours: 11.6,
    staleAfterHours: 3,
    stale: true,
    heartbeatAt: ago(40.6),
    newestObjectAt: ago(11.6),
    ...over,
  };
}

describe("describeDrStaleness", () => {
  it("returns null for a healthy row so callers stay a plain if", () => {
    expect(describeDrStaleness(row({ stale: false }), NOW)).toBeNull();
  });

  it("calls the Sep 16 shape a FAILING SYNC, not a stale stream", () => {
    const out = describeDrStaleness(row(), NOW);
    expect(out?.kind).toBe("sync-failing");
    // Says both halves out loud: files are landing, runs are not completing.
    expect(out?.detail).toContain("still copying");
    expect(out?.detail).toContain("12h ago");
    expect(out?.detail).toContain("41h");
    // And points at the one place the failing object is actually named.
    expect(out?.detail).toContain("cron-dr-uploads-sync.log");
  });

  it("does NOT claim a failing sync when nothing has landed since the heartbeat", () => {
    // A genuinely dead cron: heartbeat 6h old, newest object older still.
    const out = describeDrStaleness(
      row({ heartbeatAt: ago(6), newestObjectAt: ago(20), latestAt: ago(6), ageHours: 6 }),
      NOW,
    );
    expect(out?.kind).toBe("nothing-arriving");
    expect(out?.detail).toContain("Expected within 3h");
  });

  it("keeps the pre-crontab wording when there is no heartbeat at all", () => {
    const out = describeDrStaleness(
      row({ heartbeatAt: null, newestObjectAt: ago(15.3), latestAt: ago(15.3), ageHours: 15.3 }),
      NOW,
    );
    expect(out?.kind).toBe("nothing-arriving");
    expect(out?.detail).toContain("15h old");
  });

  it("reports an empty prefix as having no restore point at all", () => {
    const out = describeDrStaleness(row({ latestAt: null, ageHours: null, heartbeatAt: null, newestObjectAt: null }), NOW);
    expect(out?.kind).toBe("never-arrived");
    expect(out?.detail).toContain("uploads/");
  });

  it("needs the heartbeat to be PAST the threshold, not merely at it", () => {
    // Exactly at 3h is not yet a failing sync: >, never >=.
    const at = describeDrStaleness(row({ heartbeatAt: ago(3), newestObjectAt: ago(1) }), NOW);
    expect(at?.kind).toBe("nothing-arriving");
    const past = describeDrStaleness(row({ heartbeatAt: ago(3.1), newestObjectAt: ago(1) }), NOW);
    expect(past?.kind).toBe("sync-failing");
  });

  it("degrades instead of throwing on an unparseable timestamp", () => {
    const out = describeDrStaleness(row({ heartbeatAt: "not-a-date" }), NOW);
    expect(out?.kind).toBe("nothing-arriving");
  });
});
