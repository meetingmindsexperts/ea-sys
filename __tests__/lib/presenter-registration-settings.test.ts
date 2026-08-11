/**
 * Presenter Pay Now toggle (Aug 11, 2026). Plan decision D3.
 *
 * The polarity is the whole point. Abstract submitters get a quote either way;
 * this decides only whether they are INVITED to pay at submission. On the
 * organizer's own figure roughly 29 in 30 are comped after acceptance, so the
 * expensive mistake is asking everyone for money, and a malformed settings
 * blob must never land there.
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_PRESENTER_REGISTRATION_SETTINGS,
  isPresenterPayNowEnabled,
  readPresenterRegistrationSettings,
} from "@/lib/presenter-registration-settings";

describe("readPresenterRegistrationSettings", () => {
  /** Every existing event has no such key, so this is the estate's behaviour. */
  it("defaults to NOT asking for payment", () => {
    for (const settings of [null, undefined, {}, { other: 1 }]) {
      expect(readPresenterRegistrationSettings(settings)).toEqual(
        DEFAULT_PRESENTER_REGISTRATION_SETTINGS,
      );
    }
    expect(DEFAULT_PRESENTER_REGISTRATION_SETTINGS.payNowEnabled).toBe(false);
  });

  it("reads an explicit opt-in", () => {
    expect(
      readPresenterRegistrationSettings({ presenterRegistration: { payNowEnabled: true } })
        .payNowEnabled,
    ).toBe(true);
  });

  it("reads an explicit opt-out", () => {
    expect(
      readPresenterRegistrationSettings({ presenterRegistration: { payNowEnabled: false } })
        .payNowEnabled,
    ).toBe(false);
  });

  /**
   * Fails to the cheap side. A truthy-but-not-boolean value is a sign the blob
   * was written by something we do not control, and guessing "yes, invoice
   * everyone" from `"yes"` or `1` is the wrong guess to make.
   */
  it("treats any non-boolean-true value as off", () => {
    for (const v of ["true", 1, "yes", {}, [], "on"]) {
      expect(
        readPresenterRegistrationSettings({ presenterRegistration: { payNowEnabled: v } })
          .payNowEnabled,
      ).toBe(false);
    }
  });

  it("ignores a non-object blob rather than throwing", () => {
    for (const v of [[], "x", 5, true, null]) {
      expect(readPresenterRegistrationSettings({ presenterRegistration: v })).toEqual(
        DEFAULT_PRESENTER_REGISTRATION_SETTINGS,
      );
    }
  });
});

describe("isPresenterPayNowEnabled", () => {
  it("agrees with the full reader", () => {
    expect(isPresenterPayNowEnabled({ presenterRegistration: { payNowEnabled: true } })).toBe(true);
    expect(isPresenterPayNowEnabled({})).toBe(false);
    expect(isPresenterPayNowEnabled(null)).toBe(false);
  });
});
