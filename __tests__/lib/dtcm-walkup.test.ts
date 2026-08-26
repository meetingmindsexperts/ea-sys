/**
 * The walk-up DTCM warning.
 *
 * WHY IT EXISTS. An empty spare pool is silent by design: the registration
 * succeeds (a compliance code is not a precondition for existing) and the badge
 * simply prints with no QR on it. Nothing on screen says so, so the failure is
 * discovered by a DTCM inspector rather than by us. This helper is the one
 * place that decides when to say it, shared by the two create surfaces —
 * because a condition written twice is a condition that drifts once.
 */
import { describe, it, expect } from "vitest";
import { dtcmWalkupWarning } from "@/lib/dtcm-walkup";

describe("dtcmWalkupWarning", () => {
  it("warns when a Dubai walk-up got no code", () => {
    const msg = dtcmWalkupWarning({
      requiresDtcm: true,
      attendanceMode: "IN_PERSON",
      dtcmBarcode: null,
    });
    expect(msg).toBeTruthy();
    // Names the consequence and the remedy, not just the fact.
    expect(msg).toContain("compliance QR");
    expect(msg).toContain("Import more codes");
  });

  it("stays silent when a code WAS assigned", () => {
    expect(
      dtcmWalkupWarning({ requiresDtcm: true, attendanceMode: "IN_PERSON", dtcmBarcode: "DTCM-1" }),
    ).toBeNull();
  });

  it("stays silent on a non-Dubai event", () => {
    // The 95% case. Warning here would be noise the desk learns to ignore,
    // which is how a real warning gets missed.
    expect(
      dtcmWalkupWarning({ requiresDtcm: false, attendanceMode: "IN_PERSON", dtcmBarcode: null }),
    ).toBeNull();
  });

  it("stays silent for a VIRTUAL attendee", () => {
    // No badge at all, so no QR to be missing. Matches the claim helper and the
    // badge renderer, both of which skip virtual for the same reason.
    expect(
      dtcmWalkupWarning({ requiresDtcm: true, attendanceMode: "VIRTUAL", dtcmBarcode: null }),
    ).toBeNull();
  });

  it("fails silent on absent flags rather than crying wolf", () => {
    // `requiresDtcm` arrives from a React Query cache that may not have loaded
    // yet. Undefined must not read as "Dubai" — a spurious warning on every
    // ordinary registration would train the desk to dismiss the real one.
    expect(dtcmWalkupWarning({ requiresDtcm: undefined })).toBeNull();
    expect(dtcmWalkupWarning({ requiresDtcm: null })).toBeNull();
  });

  it("warns when attendanceMode is missing but the event is Dubai", () => {
    // Only VIRTUAL is exempt. An unknown mode defaults to warning, because the
    // cost of a needless warning is a dismissed toast and the cost of a missed
    // one is a non-compliant badge.
    expect(dtcmWalkupWarning({ requiresDtcm: true, dtcmBarcode: null })).toBeTruthy();
  });

  it("treats an empty-string code as no code", () => {
    expect(
      dtcmWalkupWarning({ requiresDtcm: true, attendanceMode: "IN_PERSON", dtcmBarcode: "" }),
    ).toBeTruthy();
  });
});
