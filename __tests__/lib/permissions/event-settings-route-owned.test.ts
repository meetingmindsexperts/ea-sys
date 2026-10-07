/**
 * Phase 6 review (Oct 7, 2026): the event edit's `settings` key is gated by
 * `events.settings`, but some sub-keys belong to another permission and have
 * their own routes. WEBINARS (events.settings on webinars, no certificate or
 * reimbursement key) could rewrite the CME accreditation printed on
 * certificates through it. The edit now drops those sub-keys, and a save
 * that carries only them changes nothing, so it needs no key either.
 */
import { describe, it, expect } from "vitest";
import {
  changedEventFields,
  editableEventSettings,
  ROUTE_OWNED_SETTINGS_KEYS,
} from "@/lib/permissions/field-permissions";

describe("route-owned settings are not writable through the event edit", () => {
  it("drops exactly the route-owned keys", () => {
    const body = { registrationOpen: true, cme: { accreditations: [] }, reimbursement: {}, webinar: { x: 1 }, reviewerUserIds: ["u"], handouts: [] };
    expect(editableEventSettings(body)).toEqual({ registrationOpen: true });
    expect([...ROUTE_OWNED_SETTINGS_KEYS].sort()).toEqual(["cme", "handouts", "reimbursement", "reviewerUserIds", "webinar"]);
  });

  it("a save carrying only route-owned changes does not count as a settings change", () => {
    const stored = { settings: { cme: { accreditations: ["old"] } } };
    expect(changedEventFields({ settings: { cme: { accreditations: ["new"] } } }, stored)).toEqual([]);
    expect(changedEventFields({ settings: { cme: { accreditations: ["new"] }, registrationOpen: true } }, stored)).toEqual(["settings"]);
  });
});
