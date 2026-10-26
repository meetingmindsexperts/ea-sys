/**
 * The public registration form survives a reload (Oct 26, 2026): saved per
 * event and category in that tab's sessionStorage, ignored when stale or
 * malformed, and harmless when storage throws.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { clearRegisterDraft, readRegisterDraft, registerDraftKey, writeRegisterDraft } from "@/lib/register-draft";

const store = new Map<string, string>();
const sessionStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

beforeEach(() => {
  store.clear();
  vi.stubGlobal("window", { sessionStorage });
  vi.useRealTimers();
});

const draft = { step: 2 as const, values: { email: "a@b.com", firstName: "Asha" }, billingSame: true, promoCode: "VERTEX", supportingDoc: null };
const key = registerDraftKey("BHS2026", "inclusive");

describe("register draft", () => {
  it("is keyed by event and category, so two links never share answers", () => {
    expect(key).toBe("ea-sys:register-draft:BHS2026:inclusive");
    expect(registerDraftKey("BHS2026", "early-bird")).not.toBe(key);
  });

  it("writes and reads back what the person typed and where they were", () => {
    writeRegisterDraft(key, draft);
    expect(readRegisterDraft(key)).toMatchObject(draft);
  });

  it("clear removes it (after a successful registration)", () => {
    writeRegisterDraft(key, draft);
    clearRegisterDraft(key);
    expect(readRegisterDraft(key)).toBeNull();
  });

  it("ignores a draft older than 12 hours, and one in an unknown shape", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-26T08:00:00Z"));
    writeRegisterDraft(key, draft);
    vi.setSystemTime(new Date("2026-10-26T20:00:01Z"));
    expect(readRegisterDraft(key)).toBeNull();
    store.set(key, JSON.stringify({ v: 99, values: {} }));
    expect(readRegisterDraft(key)).toBeNull();
    store.set(key, "not json");
    expect(readRegisterDraft(key)).toBeNull();
  });

  it("never throws when storage is blocked (private windows)", () => {
    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: () => { throw new Error("blocked"); },
        setItem: () => { throw new Error("blocked"); },
        removeItem: () => { throw new Error("blocked"); },
      },
    });
    expect(() => writeRegisterDraft(key, draft)).not.toThrow();
    expect(readRegisterDraft(key)).toBeNull();
    expect(() => clearRegisterDraft(key)).not.toThrow();
  });
});
