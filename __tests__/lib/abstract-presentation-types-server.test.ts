/**
 * Loading the organisation's presentation types (review of 89d803698: no test
 * read the loader itself; the suite passed through its fallback instead).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { orgFind, eventFind, logger } = vi.hoisted(() => ({
  orgFind: vi.fn(),
  eventFind: vi.fn(),
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: { organization: { findUnique: orgFind }, event: { findUnique: eventFind } } }));
vi.mock("@/lib/logger", () => ({ apiLogger: logger }));

import {
  loadPresentationTypes,
  loadPresentationTypesForEvent,
  loadPresentationTypesStrict,
  resetPresentationTypeCache,
} from "@/lib/abstract-presentation-types-server";
import { defaultPresentationTypes, presentationTypeLabel } from "@/lib/abstract-presentation-types";

const STORED = { presentationTypes: [{ key: "POSTER", label: "E-poster" }, { key: "SYMPOSIUM", label: "Symposium" }] };

beforeEach(() => {
  vi.clearAllMocks();
  resetPresentationTypeCache();
});

describe("loadPresentationTypes (a reader)", () => {
  it("reads the organisation's own list", async () => {
    orgFind.mockResolvedValue({ settings: STORED });
    const types = await loadPresentationTypes("org1");
    expect(orgFind).toHaveBeenCalledWith({ where: { id: "org1" }, select: { settings: true } });
    expect(presentationTypeLabel(types, "POSTER")).toBe("E-poster");
    expect(types.map((t) => t.key)).toContain("SYMPOSIUM");
  });

  it("an organisation that never edited it has the five built-ins", async () => {
    orgFind.mockResolvedValue({ settings: {} });
    expect(await loadPresentationTypes("org1")).toEqual(defaultPresentationTypes());
  });

  it("no organisation id, no read", async () => {
    expect(await loadPresentationTypes(null)).toEqual(defaultPresentationTypes());
    expect(orgFind).not.toHaveBeenCalled();
  });

  it("a missing organisation or a failed read gives the built-ins, logged", async () => {
    orgFind.mockResolvedValueOnce(null);
    expect(await loadPresentationTypes("gone")).toEqual(defaultPresentationTypes());
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "presentation-types:organization-not-found" }));
    orgFind.mockRejectedValueOnce(new Error("down"));
    expect(await loadPresentationTypes("org2")).toEqual(defaultPresentationTypes());
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ msg: "presentation-types:read-failed" }));
  });

  it("is served from a short cache, so a bulk send does not read once per email", async () => {
    orgFind.mockResolvedValue({ settings: STORED });
    await loadPresentationTypes("org1");
    await loadPresentationTypes("org1");
    expect(orgFind).toHaveBeenCalledTimes(1);
  });

  it("by event: finds the event's organisation once, then its list", async () => {
    eventFind.mockResolvedValue({ organizationId: "org1" });
    orgFind.mockResolvedValue({ settings: STORED });
    const types = await loadPresentationTypesForEvent("ev1");
    await loadPresentationTypesForEvent("ev1");
    expect(presentationTypeLabel(types, "POSTER")).toBe("E-poster");
    expect(eventFind).toHaveBeenCalledTimes(1);
    expect(orgFind).toHaveBeenCalledTimes(1);
  });

  it("by event: an event this lane cannot see gives the built-ins, logged", async () => {
    eventFind.mockResolvedValue(null);
    expect(await loadPresentationTypesForEvent("hidden")).toEqual(defaultPresentationTypes());
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "presentation-types:event-not-found" }));
  });
});

describe("loadPresentationTypesStrict (a writer)", () => {
  it("reads every time, never from the cache", async () => {
    orgFind.mockResolvedValue({ settings: STORED });
    await loadPresentationTypes("org1");
    await loadPresentationTypesStrict("org1");
    await loadPresentationTypesStrict("org1");
    expect(orgFind).toHaveBeenCalledTimes(3);
  });

  it("throws when the read fails or finds no organisation, rather than judging by the built-ins", async () => {
    orgFind.mockRejectedValueOnce(new Error("down"));
    await expect(loadPresentationTypesStrict("org1")).rejects.toThrow("down");
    orgFind.mockResolvedValueOnce(null);
    await expect(loadPresentationTypesStrict("gone")).rejects.toThrow(/no organisation/);
  });
});
