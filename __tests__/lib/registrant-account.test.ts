/**
 * `ensureRegistrantAccount` — the create-or-link REGISTRANT block shared by the
 * public `register` + `complete-registration` routes (extracted from two
 * byte-identical copies). These pin the behavior the routes relied on so the
 * dedup can't silently drift: no-password no-op, existing-user link + sibling
 * sweep + first-time-only terms stamp, new-user create with internal-domain
 * org-attach + verify-email, and failure isolation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, hashSpy, isTrustedSpy, needsVerifySpy, sendVerifySpy, notifySpy, errorSpy, warnSpy } =
  vi.hoisted(() => ({
    mockDb: {
      user: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
      registration: { update: vi.fn(), updateMany: vi.fn() },
    },
    hashSpy: vi.fn().mockResolvedValue("hashed-pw"),
    isTrustedSpy: vi.fn().mockReturnValue(false),
    needsVerifySpy: vi.fn().mockReturnValue(false),
    sendVerifySpy: vi.fn().mockResolvedValue(undefined),
    notifySpy: vi.fn().mockResolvedValue(undefined),
    errorSpy: vi.fn(),
    warnSpy: vi.fn(),
  }));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("bcryptjs", () => ({ default: { hash: hashSpy } }));
vi.mock("@/lib/internal-domains", () => ({
  isTrustedInternalEmail: isTrustedSpy,
  needsEmailVerification: needsVerifySpy,
}));
vi.mock("@/lib/email-verification", () => ({ sendEmailVerification: sendVerifySpy }));
vi.mock("@/lib/notifications", () => ({ notifyEventAdmins: notifySpy }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: warnSpy, error: errorSpy } }));

import { ensureRegistrantAccount } from "@/lib/registrant-account";

const base = {
  registrationId: "reg1",
  eventId: "ev1",
  organizationId: "org1",
  email: "jane@example.com",
  firstName: "Jane",
  lastName: "Doe",
  password: "secret123",
  specialty: "Cardiology" as string | null,
  clientIp: "1.2.3.4",
  signupMessage: "Jane Doe (jane@example.com) created a registrant account",
};

beforeEach(() => {
  vi.clearAllMocks();
  isTrustedSpy.mockReturnValue(false);
  needsVerifySpy.mockReturnValue(false);
  mockDb.user.findUnique.mockResolvedValue(null);
  mockDb.user.create.mockResolvedValue({ id: "u-new" });
  mockDb.registration.update.mockResolvedValue({});
  mockDb.registration.updateMany.mockResolvedValue({ count: 1 });
  mockDb.user.update.mockResolvedValue({});
});

describe("ensureRegistrantAccount", () => {
  it("no-ops when no password (guest registration) — touches nothing", async () => {
    await ensureRegistrantAccount({ ...base, password: undefined });
    expect(mockDb.user.findUnique).not.toHaveBeenCalled();
    expect(mockDb.user.create).not.toHaveBeenCalled();
    expect(mockDb.registration.updateMany).not.toHaveBeenCalled();
  });

  it("existing user: links this reg + sweeps siblings + stamps terms first time", async () => {
    mockDb.user.findUnique.mockResolvedValue({ id: "u-exist", role: "REGISTRANT", termsAcceptedAt: null });
    await ensureRegistrantAccount(base);
    expect(mockDb.registration.update).toHaveBeenCalledWith({
      where: { id: "reg1" },
      data: { userId: "u-exist" },
    });
    expect(mockDb.registration.updateMany).toHaveBeenCalledWith({
      where: { attendee: { email: "jane@example.com" }, userId: null },
      data: { userId: "u-exist" },
    });
    expect(mockDb.user.update).toHaveBeenCalledWith({
      where: { id: "u-exist" },
      data: { termsAcceptedAt: expect.any(Date), termsAcceptedIp: "1.2.3.4" },
    });
    expect(mockDb.user.create).not.toHaveBeenCalled();
  });

  it("existing user with terms already accepted: does NOT overwrite the stamp", async () => {
    mockDb.user.findUnique.mockResolvedValue({ id: "u-exist", role: "REGISTRANT", termsAcceptedAt: new Date() });
    await ensureRegistrantAccount(base);
    expect(mockDb.user.update).not.toHaveBeenCalled();
  });

  it("new user: creates REGISTRANT, org-null for external, sweeps siblings, notifies", async () => {
    await ensureRegistrantAccount(base);
    expect(mockDb.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          email: "jane@example.com",
          passwordHash: "hashed-pw",
          role: "REGISTRANT",
          organizationId: null, // external email → org-independent
          specialty: "Cardiology",
        }),
      }),
    );
    expect(mockDb.registration.updateMany).toHaveBeenCalledWith({
      where: { attendee: { email: "jane@example.com" }, userId: null },
      data: { userId: "u-new" },
    });
    expect(notifySpy).toHaveBeenCalledWith(
      "ev1",
      expect.objectContaining({ type: "SIGNUP", message: base.signupMessage }),
    );
    expect(sendVerifySpy).not.toHaveBeenCalled(); // needsVerify=false
  });

  it("new user on a trusted internal domain: attaches the org immediately", async () => {
    isTrustedSpy.mockReturnValue(true);
    await ensureRegistrantAccount(base);
    expect(mockDb.user.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ organizationId: "org1" }) }),
    );
  });

  it("new user needing verification: sends the verify link", async () => {
    needsVerifySpy.mockReturnValue(true);
    await ensureRegistrantAccount(base);
    expect(sendVerifySpy).toHaveBeenCalledWith({ email: "jane@example.com", name: "Jane Doe" });
  });

  it("failure-isolated: a DB error is logged (error) and swallowed, never thrown", async () => {
    mockDb.user.findUnique.mockRejectedValue(new Error("db down"));
    await expect(ensureRegistrantAccount(base)).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "registrant-account:create-or-link-failed", registrationId: "reg1" }),
    );
  });
});
