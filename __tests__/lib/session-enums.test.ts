/**
 * SessionType display helpers — the break-item hinge. `isBreakSessionType`
 * gates form sections, agenda rendering, the public detail-page 404, and the
 * service's BREAK_ITEM_HAS_PROGRAM check, so its truth table is pinned here.
 */
import { describe, it, expect } from "vitest";
import {
  BREAK_SESSION_TYPES,
  SESSION_TYPE_KIND,
  SESSION_TYPE_LABELS,
  SESSION_TYPE_OPTIONS,
  formatSessionType,
  isBreakSessionType,
  sessionNeedsTba,
  topicNeedsTba,
  TBA_LABEL,
  TBC_LABEL,
} from "@/lib/session-enums";

describe("isBreakSessionType", () => {
  it("is false for SESSION and for absent values (pre-column rows)", () => {
    expect(isBreakSessionType("SESSION")).toBe(false);
    expect(isBreakSessionType(null)).toBe(false);
    expect(isBreakSessionType(undefined)).toBe(false);
  });

  it("matches the explicit classification for every enum value — program types (SESSION/WORKSHOP/SYMPOSIUM) are never breaks", () => {
    for (const value of Object.keys(SESSION_TYPE_LABELS)) {
      expect(isBreakSessionType(value)).toBe(
        SESSION_TYPE_KIND[value as keyof typeof SESSION_TYPE_KIND] === "break"
      );
    }
    // The July 23 additions specifically: full program citizens, not breaks.
    expect(isBreakSessionType("WORKSHOP")).toBe(false);
    expect(isBreakSessionType("SYMPOSIUM")).toBe(false);
  });

  it("BREAK_SESSION_TYPES is exactly the break set (feeds Prisma notIn count filters)", () => {
    expect([...BREAK_SESSION_TYPES].sort()).toEqual(
      ["BREAK", "LUNCH", "NETWORKING", "REGISTRATION"]
    );
  });

  it("treats an unknown wire value as a real session (never hides content on bad data)", () => {
    expect(isBreakSessionType("COFFEE")).toBe(false);
    expect(isBreakSessionType("")).toBe(false);
  });
});

describe("formatSessionType", () => {
  it("labels every enum value", () => {
    expect(formatSessionType("BREAK")).toBe("Coffee Break");
    expect(formatSessionType("LUNCH")).toBe("Lunch Break");
    expect(formatSessionType("REGISTRATION")).toBe("Registration");
    expect(formatSessionType("NETWORKING")).toBe("Networking");
    expect(formatSessionType(null)).toBe("Session");
  });

  it("degrades an unknown value to Title Case, never raw", () => {
    expect(formatSessionType("SOMETHING_NEW")).toBe("Something_new");
  });
});

describe("SESSION_TYPE_OPTIONS", () => {
  it("covers every enum value exactly once, SESSION first", () => {
    expect(SESSION_TYPE_OPTIONS[0].value).toBe("SESSION");
    expect(new Set(SESSION_TYPE_OPTIONS.map((o) => o.value)).size).toBe(
      Object.keys(SESSION_TYPE_LABELS).length,
    );
  });
});

/**
 * TBA placeholder — a programme slot with nobody assigned.
 *
 * Fixtures are the two real shapes found on prod (2026-08-17) when this
 * shipped, because both encode a rule that a plausible-looking implementation
 * gets wrong:
 *
 *   Industry Symposium  0 session speakers, 0 topics          → TBA
 *   Keynote Lecture     0 session speakers, 1 topic w/ speaker → NOT TBA
 *
 * The first fails if the predicate keys on `type === "SESSION"`; the second
 * fails if it only looks at session-level speakers. Both are mutation-verified.
 */
describe("sessionNeedsTba", () => {
  const spk = { speaker: { id: "s1" } };

  it("prod case: a Symposium with no speakers and no topics shows TBA", () => {
    expect(
      sessionNeedsTba({ type: "SYMPOSIUM", speakers: [], topics: [] })
    ).toBe(true);
  });

  it("prod case: a session whose speaker is named on its TOPIC does NOT show TBA", () => {
    // "Keynote Lecture" on EHS. Checking only session-level speakers would
    // print TBA directly above the keynote speaker's own name.
    expect(
      sessionNeedsTba({
        type: "SESSION",
        speakers: [],
        topics: [{ speakers: [spk] }],
      })
    ).toBe(false);
  });

  it("applies to every program type, not just SESSION", () => {
    // Mutation guard: `type === "SESSION"` passes the SESSION case below and
    // fails the other two — which are the ones that actually occur on prod.
    for (const type of ["SESSION", "WORKSHOP", "SYMPOSIUM"]) {
      expect(sessionNeedsTba({ type, speakers: [], topics: [] })).toBe(true);
    }
  });

  it("never applies to a break item", () => {
    for (const type of BREAK_SESSION_TYPES) {
      expect(sessionNeedsTba({ type, speakers: [], topics: [] })).toBe(false);
    }
  });

  it("treats an absent or unknown type as a program session (fails open)", () => {
    // Same direction as isBreakSessionType: bad data shows TBA on a real
    // session rather than silently hiding it as a coffee break.
    expect(sessionNeedsTba({ speakers: [], topics: [] })).toBe(true);
    expect(sessionNeedsTba({ type: null, speakers: [], topics: [] })).toBe(true);
    expect(sessionNeedsTba({ type: "FUTURE_TYPE", speakers: [], topics: [] })).toBe(true);
  });

  it("does not apply once anyone is assigned, at either level", () => {
    expect(
      sessionNeedsTba({ type: "SESSION", speakers: [spk], topics: [] })
    ).toBe(false);
    expect(
      sessionNeedsTba({
        type: "SESSION",
        speakers: [],
        topics: [{ speakers: [] }, { speakers: [spk] }],
      })
    ).toBe(false);
  });

  it("tolerates a missing topics array", () => {
    expect(sessionNeedsTba({ type: "SESSION", speakers: [] })).toBe(true);
    expect(sessionNeedsTba({ type: "SESSION", speakers: [], topics: null })).toBe(true);
  });
});

describe("topicNeedsTba", () => {
  it("flags a topic with no speaker inside a session that has one", () => {
    expect(topicNeedsTba({ topicSpeakerCount: 0, sessionShowsTba: false })).toBe(true);
  });

  it("stays quiet when the session already reads TBA", () => {
    // Otherwise an empty session repeats the same word on every row beneath a
    // heading that has just said it.
    expect(topicNeedsTba({ topicSpeakerCount: 0, sessionShowsTba: true })).toBe(false);
  });

  it("stays quiet when the topic has a speaker", () => {
    expect(topicNeedsTba({ topicSpeakerCount: 2, sessionShowsTba: false })).toBe(false);
  });
});

describe("placeholder labels", () => {
  it("are the wording the owner chose", () => {
    expect(TBA_LABEL).toBe("TBA");
    expect(TBC_LABEL).toBe("TBC");
  });
});
