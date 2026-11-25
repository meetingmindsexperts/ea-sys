/** The organiser's webinar email sequence (Nov 25, 2026): src/lib/webinar-sequence-plan.ts. */
import { describe, it, expect } from "vitest";
import {
  phasesSwitchedOn,
  sequenceSyncOf,
  PHASE_RULES,
  SEQUENCE_PHASES,
  cloneSequencePlan,
  defaultPhaseChoices,
  describePhaseTime,
  readSequencePlan,
  sequencePlanSchema,
} from "@/lib/webinar-sequence-plan";
import { cloneEventSettings } from "@/lib/event-clone-settings";
import { WEBINAR_SEQUENCE_PHASES } from "@/lib/webinar-email-sequence";

describe("readSequencePlan", () => {
  it("no plan stored: the usual five, not stored and not confirmed", () => {
    const plan = readSequencePlan({ webinar: { sessionId: "s1" } });
    expect(plan).toMatchObject({ stored: false, confirmed: false });
    expect(plan.phases).toEqual(defaultPhaseChoices());
    expect(plan.phases["webinar-reminder-24h"]).toEqual({ enabled: true, minutes: 24 * 60 });
    expect(plan.phases["webinar-thank-you"]).toEqual({ enabled: true, minutes: 5 });
  });

  it("a stored plan is read, and a bad or out-of-range value falls back or is held to its bounds", () => {
    const plan = readSequencePlan({
      webinar: {
        sequence: {
          confirmed: true,
          phases: {
            "webinar-reminder-1h": { enabled: false, minutes: 90 },
            "webinar-thank-you": { enabled: true, minutes: 100000 },
            "webinar-live-now": { enabled: true, minutes: "soon" },
          },
        },
      },
    });
    expect(plan).toMatchObject({ stored: true, confirmed: true });
    expect(plan.phases["webinar-reminder-1h"]).toEqual({ enabled: false, minutes: 90 });
    expect(plan.phases["webinar-thank-you"].minutes).toBe(PHASE_RULES["webinar-thank-you"].max);
    expect(plan.phases["webinar-live-now"].minutes).toBe(0);
    expect(plan.phases["webinar-reminder-24h"]).toEqual({ enabled: true, minutes: 24 * 60 });
  });

  it("the engine's phase list is this one", () => {
    expect([...WEBINAR_SEQUENCE_PHASES]).toEqual([...SEQUENCE_PHASES]);
  });
});

describe("sequencePlanSchema", () => {
  const all = defaultPhaseChoices();
  it("takes every phase with minutes inside its bounds", () => {
    expect(sequencePlanSchema.safeParse({ phases: all }).success).toBe(true);
  });
  it("refuses a missing phase, an unknown one, a fraction or a time out of bounds", () => {
    const { ["webinar-live-now"]: _drop, ...missing } = all;
    void _drop;
    expect(sequencePlanSchema.safeParse({ phases: missing }).success).toBe(false);
    expect(sequencePlanSchema.safeParse({ phases: { ...all, "webinar-confirmation": { enabled: true, minutes: 1 } } }).success).toBe(false);
    expect(sequencePlanSchema.safeParse({ phases: { ...all, "webinar-reminder-1h": { enabled: true, minutes: 1.5 } } }).success).toBe(false);
    expect(sequencePlanSchema.safeParse({ phases: { ...all, "webinar-live-now": { enabled: true, minutes: 61 } } }).success).toBe(false);
    expect(sequencePlanSchema.safeParse({ phases: { ...all, "webinar-thank-you": { enabled: true, minutes: 0 } } }).success).toBe(false);
  });
});

describe("a clone", () => {
  it("keeps the organiser's choices and never the confirmation", () => {
    expect(cloneSequencePlan({ confirmed: true, phases: { "webinar-reminder-1h": { enabled: false, minutes: 60 } } })).toEqual({
      confirmed: false,
      phases: { "webinar-reminder-1h": { enabled: false, minutes: 60 } },
    });
    const out = cloneEventSettings({ webinar: { sessionId: "src-session", viewingMode: "hls", sequence: { confirmed: true, phases: {} } } });
    expect(out.webinar).toMatchObject({ viewingMode: "hls", sequence: { confirmed: false } });
    expect(out.webinar).not.toHaveProperty("sessionId");
  });
});

describe("describePhaseTime", () => {
  it("says when, in the card's words", () => {
    expect(describePhaseTime("webinar-reminder-24h", 24 * 60)).toBe("1 day before the start");
    expect(describePhaseTime("webinar-reminder-24h", 3 * 24 * 60)).toBe("3 days before the start");
    expect(describePhaseTime("webinar-reminder-1h", 120)).toBe("2 hours before the start");
    expect(describePhaseTime("webinar-reminder-15m", 15)).toBe("15 minutes before the start");
    expect(describePhaseTime("webinar-live-now", 0)).toBe("when it starts");
    expect(describePhaseTime("webinar-thank-you", 5)).toBe("5 minutes after the room closes");
  });
});

describe("review of 3e967af29", () => {
  it("a save may bring back only the phases it switched on, against the saved plan or in this edit", () => {
    const before = { ...defaultPhaseChoices(), "webinar-live-now": { enabled: false, minutes: 0 } };
    const after = { ...defaultPhaseChoices(), "webinar-thank-you": { enabled: true, minutes: 20 } };
    expect(phasesSwitchedOn(before, after)).toEqual(["webinar-live-now"]);
    expect(phasesSwitchedOn(defaultPhaseChoices(), after)).toEqual([]);
    expect(phasesSwitchedOn(defaultPhaseChoices(), after, ["webinar-reminder-1h"])).toEqual(["webinar-reminder-1h"]);
    // A switch turned on and then off again in the edit brings nothing back.
    const off = { ...after, "webinar-reminder-1h": { enabled: false, minutes: 60 } };
    expect(phasesSwitchedOn(defaultPhaseChoices(), off, ["webinar-reminder-1h"])).toEqual([]);
  });

  it("a date move on an unscheduled webinar is reported as such, not as rescheduled", () => {
    expect(sequenceSyncOf({ ok: true, skipped: "not-scheduled" })).toBe("not-scheduled");
    expect(sequenceSyncOf({ ok: true, skipped: null })).toBe("rescheduled");
    expect(sequenceSyncOf({ ok: true, skipped: "no-future-phases" })).toBe("rescheduled");
    expect(sequenceSyncOf({ ok: false, skipped: "no-anchor-session" })).toBe("failed");
  });
});
