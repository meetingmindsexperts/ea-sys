/**
 * Accounts made at /signup (Nov 5, 2026; docs/ACCOUNT_CONFIRMATION_PLAN.md
 * phase 2): who sign-in refuses until the address is confirmed, that every
 * password door asks, and what the 30-day clean-up may delete.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Prisma } from "@prisma/client";

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    registration: { findFirst: vi.fn() },
    speaker: { findFirst: vi.fn() },
    user: { findMany: vi.fn(), delete: vi.fn() },
  },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { signInNeedsConfirmation } from "@/lib/account-signup";
import { runUnconfirmedAccountPruneTick, SIGNUP_LAUNCHED_AT } from "@/lib/unconfirmed-account-prune-worker";

const readSource = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
/** Strip comments so a source assertion cannot pass on its own explanation. */
const codeOnly = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.registration.findFirst.mockResolvedValue(null);
  mockDb.speaker.findFirst.mockResolvedValue(null);
});

describe("signInNeedsConfirmation", () => {
  const signup = { id: "u1", role: "REGISTRANT" as const, emailConfirmedAt: null };

  it("refuses an unconfirmed registrant with nothing of its own: an account made at /signup", async () => {
    expect(await signInNeedsConfirmation(signup)).toBe(true);
  });

  it("lets in an account made on a registration form: registering needs no confirmation (owner)", async () => {
    mockDb.registration.findFirst.mockResolvedValue({ id: "r1" });
    expect(await signInNeedsConfirmation(signup)).toBe(false);
  });

  it("lets in a registrant with a speaker record, and any confirmed account", async () => {
    mockDb.speaker.findFirst.mockResolvedValue({ id: "s1" });
    expect(await signInNeedsConfirmation(signup)).toBe(false);
    mockDb.speaker.findFirst.mockResolvedValue(null);
    expect(await signInNeedsConfirmation({ ...signup, emailConfirmedAt: new Date() })).toBe(false);
  });

  it("never touches staff, reviewers or submitters, and does not even look them up", async () => {
    for (const role of ["ADMIN", "ORGANIZER", "MEMBER", "REVIEWER", "SUBMITTER"] as const) {
      expect(await signInNeedsConfirmation({ ...signup, role })).toBe(false);
    }
    expect(mockDb.registration.findFirst).not.toHaveBeenCalled();
  });
});

describe("every password door asks, after the password", () => {
  for (const file of ["src/lib/auth.ts", "src/app/api/auth/mobile-login/route.ts"]) {
    it(file, () => {
      const src = codeOnly(readSource(file));
      expect(src).toContain("emailConfirmedAt: true");
      const compare = src.indexOf("bcrypt.compare(");
      const ask = src.indexOf("signInNeedsConfirmation(user)");
      // After the compare, so a wrong password on such an account still reads
      // as a wrong password and nobody else learns the account exists.
      expect(compare).toBeGreaterThan(-1);
      expect(ask).toBeGreaterThan(compare);
    });
  }
});

describe("unconfirmed-account-prune", () => {
  const now = new Date("2027-01-10T04:35:00Z");

  it("considers only never-confirmed, org-less registrants made since sign-up shipped, 30+ days old, holding nothing", async () => {
    mockDb.user.findMany.mockResolvedValue([]);
    await runUnconfirmedAccountPruneTick(now);
    const where = mockDb.user.findMany.mock.calls[0][0].where;
    expect(where).toEqual({
      role: "REGISTRANT",
      organizationId: null,
      emailConfirmedAt: null,
      createdAt: { gte: SIGNUP_LAUNCHED_AT, lt: new Date("2026-12-11T04:35:00Z") },
      registrations: { none: {} },
      speakers: { none: {} },
      loginEvents: { none: { outcome: "SUCCESS" } },
    });
    // Accounts from before sign-up existed are never candidates.
    expect(SIGNUP_LAUNCHED_AT.toISOString()).toBe("2026-11-05T00:00:00.000Z");
  });

  it("deletes each candidate; one something still points at is kept and logged, never forced", async () => {
    mockDb.user.findMany.mockResolvedValue([{ id: "a" }, { id: "b" }]);
    mockDb.user.delete
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError("fk", { code: "P2003", clientVersion: "x" }));
    expect(await runUnconfirmedAccountPruneTick(now)).toEqual({ deleted: 1, skipped: 1 });
  });

  it("an unexpected error stops the tick rather than being swallowed", async () => {
    mockDb.user.findMany.mockResolvedValue([{ id: "a" }]);
    mockDb.user.delete.mockRejectedValue(new Error("connection lost"));
    await expect(runUnconfirmedAccountPruneTick(now)).rejects.toThrow("connection lost");
  });
});
