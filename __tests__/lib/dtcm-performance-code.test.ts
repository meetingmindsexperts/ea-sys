import { describe, expect, it } from "vitest";
import {
  DTCM_PERFORMANCE_CODE_MAX,
  normalizeDtcmPerformanceCode,
  resolveDtcmEventConfig,
} from "@/lib/dtcm-performance-code";

const off = { requiresDtcmBarcode: false, dtcmPerformanceCode: null };
const on = { requiresDtcmBarcode: true, dtcmPerformanceCode: "PDUB01DEC2026A" };
/** The one production event that had DTCM on before the code existed. */
const legacy = { requiresDtcmBarcode: true, dtcmPerformanceCode: null };

describe("normalizeDtcmPerformanceCode", () => {
  it("trims and upper-cases", () => {
    expect(normalizeDtcmPerformanceCode("  pdub01dec2026a ")).toBe("PDUB01DEC2026A");
  });
  it("treats blank and non-strings as no code", () => {
    expect(normalizeDtcmPerformanceCode("   ")).toBeNull();
    expect(normalizeDtcmPerformanceCode(null)).toBeNull();
    expect(normalizeDtcmPerformanceCode(42)).toBeNull();
  });
});

describe("resolveDtcmEventConfig", () => {
  it("refuses turning DTCM on without a code", () => {
    const r = resolveDtcmEventConfig({ requiresDtcmBarcode: true }, off);
    expect(r).toMatchObject({ ok: false, code: "DTCM_PERFORMANCE_CODE_REQUIRED" });
  });

  it("refuses create with DTCM on and a blank code", () => {
    const r = resolveDtcmEventConfig({ requiresDtcmBarcode: true, dtcmPerformanceCode: "  " }, null);
    expect(r).toMatchObject({ ok: false, code: "DTCM_PERFORMANCE_CODE_REQUIRED" });
  });

  it("accepts turning DTCM on with a code, normalised", () => {
    const r = resolveDtcmEventConfig({ requiresDtcmBarcode: true, dtcmPerformanceCode: "pdub01dec2026a" }, off);
    expect(r).toEqual({ ok: true, requiresDtcmBarcode: true, dtcmPerformanceCode: "PDUB01DEC2026A" });
  });

  it("accepts turning DTCM on when the code is already stored", () => {
    const stored = { requiresDtcmBarcode: false, dtcmPerformanceCode: "PDUB01DEC2026A" };
    expect(resolveDtcmEventConfig({ requiresDtcmBarcode: true }, stored)).toMatchObject({ ok: true });
  });

  it("refuses clearing the code while DTCM stays on", () => {
    const r = resolveDtcmEventConfig({ dtcmPerformanceCode: null }, on);
    expect(r).toMatchObject({ ok: false, code: "DTCM_PERFORMANCE_CODE_REQUIRED" });
  });

  it("keeps the code when DTCM is turned off", () => {
    const r = resolveDtcmEventConfig({ requiresDtcmBarcode: false }, on);
    expect(r).toEqual({ ok: true, requiresDtcmBarcode: false, dtcmPerformanceCode: "PDUB01DEC2026A" });
  });

  it("does not block an unrelated edit on the legacy event", () => {
    // An agent venue change sends neither field.
    expect(resolveDtcmEventConfig({}, legacy)).toMatchObject({ ok: true });
  });

  it("lets the legacy event's Settings tabs save: re-sending stored values is no change", () => {
    // General, Registration and Abstracts send both fields on every save. A
    // "touched" test blocked every one of them (review MED-1, Nov 3, 2026).
    const r = resolveDtcmEventConfig({ requiresDtcmBarcode: true, dtcmPerformanceCode: "" }, legacy);
    expect(r).toEqual({ ok: true, requiresDtcmBarcode: true, dtcmPerformanceCode: null });
  });

  it("still refuses turning DTCM off and on again without a code", () => {
    const stored = { requiresDtcmBarcode: false, dtcmPerformanceCode: null };
    expect(resolveDtcmEventConfig({ requiresDtcmBarcode: true, dtcmPerformanceCode: "" }, stored)).toMatchObject({
      ok: false,
      code: "DTCM_PERFORMANCE_CODE_REQUIRED",
    });
  });

  it("refuses a value that is not text instead of clearing the code", () => {
    const stored = { requiresDtcmBarcode: false, dtcmPerformanceCode: "PDUB01DEC2026A" };
    expect(resolveDtcmEventConfig({ dtcmPerformanceCode: 123 }, stored)).toMatchObject({
      ok: false,
      code: "INVALID_DTCM_PERFORMANCE_CODE",
    });
  });

  it("refuses characters DET codes never contain", () => {
    for (const bad of ["PDUB 01", "PDUB/01", "PDÜB01", "X".repeat(DTCM_PERFORMANCE_CODE_MAX + 1)]) {
      const r = resolveDtcmEventConfig({ requiresDtcmBarcode: true, dtcmPerformanceCode: bad }, off);
      expect(r).toMatchObject({ ok: false, code: "INVALID_DTCM_PERFORMANCE_CODE" });
    }
  });

  it("validates a code saved while DTCM is off", () => {
    const r = resolveDtcmEventConfig({ dtcmPerformanceCode: "bad code" }, off);
    expect(r).toMatchObject({ ok: false, code: "INVALID_DTCM_PERFORMANCE_CODE" });
  });

  it("leaves a non-DTCM event alone", () => {
    expect(resolveDtcmEventConfig({ requiresDtcmBarcode: false, dtcmPerformanceCode: "" }, off)).toEqual({
      ok: true,
      requiresDtcmBarcode: false,
      dtcmPerformanceCode: null,
    });
  });
});
