/**
 * Person-level tag sync (Registration <-> Speaker): the pure delta helpers
 * and the matching (by sourceRegistrationId + case-insensitive email).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    speaker: { findMany: vi.fn(), update: vi.fn().mockResolvedValue({}) },
    registration: { findMany: vi.fn() },
    attendee: { update: vi.fn().mockResolvedValue({}) },
  },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import {
  computeTagDelta,
  applyTagDelta,
  tagDeltaIsEmpty,
  syncRegistrationTagsToSpeakers,
  syncSpeakerTagsToRegistrations,
} from "@/lib/person-tag-sync";

beforeEach(() => vi.clearAllMocks());

describe("computeTagDelta", () => {
  it("computes added + removed", () => {
    expect(computeTagDelta(["a", "b"], ["b", "c"])).toEqual({ added: ["c"], removed: ["a"] });
  });
  it("is empty when unchanged", () => {
    expect(tagDeltaIsEmpty(computeTagDelta(["a", "b"], ["a", "b"]))).toBe(true);
  });
});

describe("applyTagDelta", () => {
  it("removes then adds, dedups, order-stable", () => {
    expect(applyTagDelta(["a", "b"], { added: ["c", "b"], removed: ["a"] })).toEqual(["b", "c"]);
  });
  it("no-op on empty delta", () => {
    expect(applyTagDelta(["a"], { added: [], removed: [] })).toEqual(["a"]);
  });
});

describe("syncRegistrationTagsToSpeakers", () => {
  it("matches by sourceRegistrationId and applies the delta to the speaker", async () => {
    mockDb.speaker.findMany.mockResolvedValue([
      { id: "spk1", tags: ["keynote"], email: "x@y.com", sourceRegistrationId: "reg1" },
    ]);
    await syncRegistrationTagsToSpeakers("ev1", [
      { registrationId: "reg1", email: "other@z.com", delta: { added: ["vip"], removed: [] } },
    ]);
    // keeps the speaker's own "keynote", adds "vip"
    expect(mockDb.speaker.update).toHaveBeenCalledWith({ where: { id: "spk1" }, data: { tags: ["keynote", "vip"] } });
  });

  it("matches by email case-insensitively when no link", async () => {
    mockDb.speaker.findMany.mockResolvedValue([
      { id: "spk2", tags: ["vip"], email: "Jane@X.com", sourceRegistrationId: null },
    ]);
    await syncRegistrationTagsToSpeakers("ev1", [
      { registrationId: "regZ", email: "jane@x.com", delta: { added: [], removed: ["vip"] } },
    ]);
    expect(mockDb.speaker.update).toHaveBeenCalledWith({ where: { id: "spk2" }, data: { tags: [] } });
  });

  it("skips empty deltas (no query, no update)", async () => {
    await syncRegistrationTagsToSpeakers("ev1", [
      { registrationId: "reg1", email: "x@y.com", delta: { added: [], removed: [] } },
    ]);
    expect(mockDb.speaker.findMany).not.toHaveBeenCalled();
    expect(mockDb.speaker.update).not.toHaveBeenCalled();
  });

  it("does not update when the delta produces no change", async () => {
    mockDb.speaker.findMany.mockResolvedValue([
      { id: "spk3", tags: ["vip"], email: "x@y.com", sourceRegistrationId: "reg1" },
    ]);
    await syncRegistrationTagsToSpeakers("ev1", [
      { registrationId: "reg1", email: "x@y.com", delta: { added: ["vip"], removed: [] } }, // already has vip
    ]);
    expect(mockDb.speaker.update).not.toHaveBeenCalled();
  });

  it("failure is isolated (never throws)", async () => {
    mockDb.speaker.findMany.mockRejectedValue(new Error("db down"));
    await expect(
      syncRegistrationTagsToSpeakers("ev1", [{ registrationId: "reg1", email: "x@y.com", delta: { added: ["vip"], removed: [] } }]),
    ).resolves.toBeUndefined();
  });
});

describe("syncSpeakerTagsToRegistrations", () => {
  it("dedups by attendee and applies the delta once", async () => {
    // Same attendee backs two registrations — must update the attendee once.
    mockDb.registration.findMany.mockResolvedValue([
      { id: "reg1", attendee: { id: "att1", tags: ["delegate"], email: "x@y.com" } },
      { id: "reg2", attendee: { id: "att1", tags: ["delegate"], email: "x@y.com" } },
    ]);
    await syncSpeakerTagsToRegistrations("ev1", [
      { speakerId: "spk1", email: "x@y.com", sourceRegistrationId: "reg1", delta: { added: ["vip"], removed: [] } },
    ]);
    expect(mockDb.attendee.update).toHaveBeenCalledTimes(1);
    expect(mockDb.attendee.update).toHaveBeenCalledWith({ where: { id: "att1" }, data: { tags: ["delegate", "vip"] } });
  });
});
