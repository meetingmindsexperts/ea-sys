/**
 * Per-event abstract limits (Aug 11, 2026).
 *
 * Four numbers that used to be constants: title words, body words, co-authors,
 * and how many abstracts one submitter may hold. The reader is the only place
 * they are interpreted, so its fail-safe behaviour is the property worth
 * pinning: a missing or corrupted config must land on the historical default,
 * never on something that makes submission impossible.
 */
import { describe, it, expect } from "vitest";
import {
  ABSTRACTS_PER_SUBMITTER_CEILING,
  ABSTRACT_STATUSES_COUNTING_TOWARD_LIMIT,
  CONTENT_WORDS_CEILING,
  CO_AUTHORS_CEILING,
  DEFAULT_ABSTRACT_LIMITS,
  DEFAULT_MAX_CO_AUTHORS,
  DEFAULT_MAX_CONTENT_WORDS,
  DEFAULT_MAX_TITLE_WORDS,
  TITLE_WORDS_CEILING,
  exceedsAbstractLimit,
  readAbstractLimits,
} from "@/lib/abstract-limits";

describe("readAbstractLimits", () => {
  /**
   * The rollout property. Every existing event has no `abstractLimits` key, so
   * if this drifted the whole estate would silently change behaviour on deploy.
   */
  it("falls back to the historical constants when nothing is configured", () => {
    for (const settings of [null, undefined, {}, { other: 1 }]) {
      expect(readAbstractLimits(settings)).toEqual(DEFAULT_ABSTRACT_LIMITS);
    }
    expect(DEFAULT_MAX_TITLE_WORDS).toBe(30);
    expect(DEFAULT_MAX_CONTENT_WORDS).toBe(300);
    expect(DEFAULT_MAX_CO_AUTHORS).toBe(20);
    expect(DEFAULT_ABSTRACT_LIMITS.maxAbstractsPerSubmitter).toBeNull();
  });

  it("reads a full configuration", () => {
    expect(
      readAbstractLimits({
        abstractLimits: {
          maxTitleWords: 15,
          maxContentWords: 250,
          maxCoAuthors: 5,
          maxAbstractsPerSubmitter: 3,
        },
      }),
    ).toEqual({
      maxTitleWords: 15,
      maxContentWords: 250,
      maxCoAuthors: 5,
      maxAbstractsPerSubmitter: 3,
    });
  });

  it("treats an absent, null or blank per-submitter cap as unlimited", () => {
    for (const v of [null, undefined, ""]) {
      expect(
        readAbstractLimits({ abstractLimits: { maxAbstractsPerSubmitter: v } })
          .maxAbstractsPerSubmitter,
      ).toBeNull();
    }
  });

  /**
   * A typo like 30 -> 3000 in the title box would let one submitter hand the
   * review committee a 3000-word "title". Clamping is quieter than refusing and
   * cannot lock an organizer out of their own settings page.
   */
  it("clamps a value above its ceiling instead of obeying it", () => {
    const l = readAbstractLimits({
      abstractLimits: {
        maxTitleWords: 99999,
        maxContentWords: 99999,
        maxCoAuthors: 99999,
        maxAbstractsPerSubmitter: 99999,
      },
    });
    expect(l.maxTitleWords).toBe(TITLE_WORDS_CEILING);
    expect(l.maxContentWords).toBe(CONTENT_WORDS_CEILING);
    expect(l.maxCoAuthors).toBe(CO_AUTHORS_CEILING);
    expect(l.maxAbstractsPerSubmitter).toBe(ABSTRACTS_PER_SUBMITTER_CEILING);
  });

  it("ignores zero, negatives and non-numbers rather than storing them", () => {
    const l = readAbstractLimits({
      abstractLimits: {
        maxTitleWords: 0,
        maxContentWords: -5,
        maxCoAuthors: "nonsense",
        maxAbstractsPerSubmitter: 0,
      },
    });
    expect(l.maxTitleWords).toBe(DEFAULT_MAX_TITLE_WORDS);
    expect(l.maxContentWords).toBe(DEFAULT_MAX_CONTENT_WORDS);
    expect(l.maxCoAuthors).toBe(DEFAULT_MAX_CO_AUTHORS);
    expect(l.maxAbstractsPerSubmitter).toBeNull(); // 0 means "no cap", not "zero allowed"
  });

  it("accepts a numeric string, which is what a number input yields", () => {
    expect(readAbstractLimits({ abstractLimits: { maxTitleWords: "12" } }).maxTitleWords).toBe(12);
  });

  it("floors a fractional value", () => {
    expect(readAbstractLimits({ abstractLimits: { maxCoAuthors: 4.9 } }).maxCoAuthors).toBe(4);
  });

  /** One bad key must not take the other three down with it. */
  it("is defensive per field, not all-or-nothing", () => {
    const l = readAbstractLimits({
      abstractLimits: { maxTitleWords: "garbage", maxCoAuthors: 3 },
    });
    expect(l.maxTitleWords).toBe(DEFAULT_MAX_TITLE_WORDS);
    expect(l.maxCoAuthors).toBe(3);
  });

  it("ignores a non-object blob", () => {
    for (const v of [[], "x", 5, true]) {
      expect(readAbstractLimits({ abstractLimits: v })).toEqual(DEFAULT_ABSTRACT_LIMITS);
    }
  });
});

describe("ABSTRACT_STATUSES_COUNTING_TOWARD_LIMIT", () => {
  /**
   * Owner decision: the cap governs the review POOL, not the archive. A
   * rejection or a withdrawal returns the slot, and drafting is always free.
   * Written as an allow-list so a future status is excluded by default.
   */
  it("counts the review pool and nothing else", () => {
    expect([...ABSTRACT_STATUSES_COUNTING_TOWARD_LIMIT].sort()).toEqual([
      "ACCEPTED",
      "REVISION_REQUESTED",
      "SUBMITTED",
      "UNDER_REVIEW",
    ]);
    for (const free of ["DRAFT", "WITHDRAWN", "REJECTED"]) {
      expect(ABSTRACT_STATUSES_COUNTING_TOWARD_LIMIT).not.toContain(free);
    }
  });
});

describe("exceedsAbstractLimit", () => {
  it("permits anything at or under the cap", () => {
    expect(exceedsAbstractLimit(5, 5)).toBe(false);
    expect(exceedsAbstractLimit(4, 5)).toBe(false);
  });

  it("refuses going over the cap on create, where there is nothing to grandfather", () => {
    expect(exceedsAbstractLimit(6, 5)).toBe(true);
    expect(exceedsAbstractLimit(6, 5, undefined)).toBe(true);
  });

  /**
   * The grandfathering rule the owner chose: lowering a cap must never make
   * existing work unsavable. An abstract with 12 co-authors under a new cap of
   * 5 can be kept as-is or trimmed, but not grown.
   */
  it("lets an over-cap value be kept unchanged", () => {
    expect(exceedsAbstractLimit(12, 5, 12)).toBe(false);
  });

  it("lets an over-cap value be reduced, even if still over", () => {
    expect(exceedsAbstractLimit(9, 5, 12)).toBe(false);
  });

  it("refuses growing an already over-cap value", () => {
    expect(exceedsAbstractLimit(13, 5, 12)).toBe(true);
  });

  it("still refuses crossing the cap from below", () => {
    // Under the cap before, over it now: this is new material, so no mercy.
    expect(exceedsAbstractLimit(6, 5, 3)).toBe(true);
  });
});
