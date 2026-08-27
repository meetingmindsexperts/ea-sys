import { describe, it, expect } from "vitest";
import { extractIdCandidates, MAX_LOOKUP_IDS } from "@/lib/id-lookup";

const EVENT_ID = "cmt8fkgbl0003ry01jjysncwe";
const REG_ID = "cmxk2p9qq0001la04h1v8bqzt";

describe("extractIdCandidates", () => {
  it("returns nothing for empty or whitespace input", () => {
    expect(extractIdCandidates("")).toEqual([]);
    expect(extractIdCandidates("   \n  ")).toEqual([]);
  });

  it("finds a bare id", () => {
    expect(extractIdCandidates(EVENT_ID)).toEqual([EVENT_ID]);
    expect(extractIdCandidates(`  ${EVENT_ID}  `)).toEqual([EVENT_ID]);
  });

  it("pulls every id out of a pasted log line, in order", () => {
    const line = `{"level":50,"msg":"registration-update:unique-constraint","eventId":"${EVENT_ID}","registrationId":"${REG_ID}"}`;
    expect(extractIdCandidates(line)).toEqual([EVENT_ID, REG_ID]);
  });

  it("de-duplicates an id repeated in one line", () => {
    const line = `event ${EVENT_ID} failed; retry for ${EVENT_ID}`;
    expect(extractIdCandidates(line)).toEqual([EVENT_ID]);
  });

  /**
   * The cap is what keeps a pasted log DUMP from turning one click into a
   * query with hundreds of IN members. Order is preserved so the ids nearest
   * the front of the paste — the ones the operator was looking at — survive.
   */
  it("caps the number of ids and keeps the first ones", () => {
    const many = Array.from(
      { length: MAX_LOOKUP_IDS + 4 },
      (_, i) => `c${String(i).padStart(2, "0")}fkgbl0003ry01jjysncwe`,
    );
    const got = extractIdCandidates(many.join(" "));
    expect(got).toHaveLength(MAX_LOOKUP_IDS);
    expect(got).toEqual(many.slice(0, MAX_LOOKUP_IDS));
  });

  /**
   * A single token that is not cuid-shaped is still worth trying — a Stripe
   * `pi_…`, an invoice number. A clean miss beats refusing to look.
   */
  it("tries a lone non-cuid token as an id", () => {
    expect(extractIdCandidates("pi_3ABCdef")).toEqual(["pi_3ABCdef"]);
  });

  /**
   * GUARD, and the one worth keeping: prose with no id in it must resolve to
   * NOTHING, never to "send the whole paste as one id". Removing the
   * single-token check would put an arbitrary blob into a database query.
   */
  it("returns nothing for multi-word text with no id in it", () => {
    expect(extractIdCandidates("the check-in scanner is refusing everyone")).toEqual([]);
    expect(extractIdCandidates('{"msg":"worker:tick-end","durationMs":12}')).toEqual([]);
  });

  it("refuses an over-long single token", () => {
    expect(extractIdCandidates("x".repeat(100))).toEqual([]);
  });

  it("ignores short words that merely start with c", () => {
    expect(extractIdCandidates("cancelled check-in")).toEqual([]);
  });
});
