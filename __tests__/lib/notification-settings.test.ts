/**
 * isNotificationEnabled — the read side of the organizer switches.
 *
 * Fails OPEN by design: only an explicit `false` suppresses. A missed
 * notification is invisible to whoever needed it; an unwanted one is noise.
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  NOTIFICATION_SETTING_KEYS,
  NOTIFICATION_SETTING_LABELS,
  isNotificationEnabled,
} from "@/lib/notification-settings";

describe("isNotificationEnabled", () => {
  it("is disabled ONLY by an explicit false", () => {
    expect(isNotificationEnabled({ notifyOnRegistration: false }, "notifyOnRegistration")).toBe(false);
  });

  it("is enabled when true, absent, null or a corrupt blob", () => {
    for (const settings of [
      { notifyOnRegistration: true },
      {},
      { other: 1 },
      null,
      undefined,
      "nonsense",
      7,
      [],
    ]) {
      expect(isNotificationEnabled(settings, "notifyOnRegistration")).toBe(true);
    }
  });

  it("does not treat a falsy-but-not-false value as off", () => {
    // 0 / "" / null in the slot are corrupt data, not an organizer decision.
    for (const v of [0, "", null, "false"]) {
      expect(isNotificationEnabled({ notifyOnRegistration: v }, "notifyOnRegistration")).toBe(true);
    }
  });

  it("reads each key independently", () => {
    const settings = { notifyOnRegistration: false, notifyOnSessionCreated: true };
    expect(isNotificationEnabled(settings, "notifyOnRegistration")).toBe(false);
    expect(isNotificationEnabled(settings, "notifyOnSessionCreated")).toBe(true);
    expect(isNotificationEnabled(settings, "notifyOnAbstractSubmission")).toBe(true);
  });
});

describe("setting catalogue", () => {
  it("every key defaults ON and carries UI copy", () => {
    for (const key of NOTIFICATION_SETTING_KEYS) {
      expect(DEFAULT_NOTIFICATION_SETTINGS[key]).toBe(true);
      expect(NOTIFICATION_SETTING_LABELS[key].label.length).toBeGreaterThan(0);
      expect(NOTIFICATION_SETTING_LABELS[key].description.length).toBeGreaterThan(0);
    }
  });
});
