/**
 * `ensureRegistrantAccount` — the create-or-link REGISTRANT block shared by the
 * public `register` + `complete-registration` routes (extracted from two
 * byte-identical copies). These pin the behavior the routes relied on so the
 * dedup can't silently drift: no-password no-op, existing-user link + sibling
 * sweep + first-time-only terms stamp, new-user create with internal-domain
 * org-attach + verify-email, and failure isolation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, hashSpy, compareSpy, isTrustedSpy, needsVerifySpy, sendVerifySpy, notifySpy, errorSpy, warnSpy } =
  vi.hoisted(() => ({
    mockDb: {
      user: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
      registration: { update: vi.fn(), updateMany: vi.fn(), findFirst: vi.fn() },
    },
    hashSpy: vi.fn().mockResolvedValue("hashed-pw"),
    compareSpy: vi.fn().mockResolvedValue(false),
    isTrustedSpy: vi.fn().mockReturnValue(false),
    needsVerifySpy: vi.fn().mockReturnValue(false),
    sendVerifySpy: vi.fn().mockResolvedValue(undefined),
    notifySpy: vi.fn().mockResolvedValue(undefined),
    errorSpy: vi.fn(),
    warnSpy: vi.fn(),
  }));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("bcryptjs", () => ({ default: { hash: hashSpy, compare: compareSpy } }));
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
  mockDb.user.findFirst.mockResolvedValue(null);
  mockDb.user.create.mockResolvedValue({ id: "u-new" });
  mockDb.registration.update.mockResolvedValue({});
  mockDb.registration.updateMany.mockResolvedValue({ count: 1 });
  mockDb.registration.findFirst.mockResolvedValue(null);
  compareSpy.mockResolvedValue(false);
  mockDb.user.update.mockResolvedValue({});
});

describe("ensureRegistrantAccount", () => {
  it("linkOnly links an existing account with no password", async () => {
    mockDb.user.findFirst.mockResolvedValue({ id: "u-exist", role: "REGISTRANT", termsAcceptedAt: new Date() });
    const out = await ensureRegistrantAccount({ ...base, password: undefined, withoutPassword: true, linkOnly: true });
    expect(out).toBe("linked");
    expect(mockDb.registration.update).toHaveBeenCalledWith({ where: { id: "reg1" }, data: { userId: "u-exist" } });
  });

  it("linkOnly never makes an account when none has this email, and logs it", async () => {
    const out = await ensureRegistrantAccount({ ...base, password: undefined, withoutPassword: true, linkOnly: true });
    expect(out).toBe("none");
    expect(mockDb.user.create).not.toHaveBeenCalled();
    expect(mockDb.registration.updateMany).not.toHaveBeenCalled();
    expect(notifySpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.objectContaining({ msg: "registrant-account:link-only-no-account" }));
  });

  it("no-ops when no password (guest registration) — touches nothing", async () => {
    await ensureRegistrantAccount({ ...base, password: undefined });
    expect(mockDb.user.findFirst).not.toHaveBeenCalled();
    expect(mockDb.user.create).not.toHaveBeenCalled();
    expect(mockDb.registration.updateMany).not.toHaveBeenCalled();
  });

  it("existing CONFIRMED account: links this reg, takes the others on its address, stamps terms first time", async () => {
    mockDb.user.findFirst.mockResolvedValue({ id: "u-exist", role: "REGISTRANT", termsAcceptedAt: null, emailConfirmedAt: new Date() });
    await ensureRegistrantAccount(base);
    expect(mockDb.registration.update).toHaveBeenCalledWith({
      where: { id: "reg1" },
      data: { userId: "u-exist" },
    });
    expect(mockDb.registration.updateMany).toHaveBeenCalledWith({
      where: { userId: null, attendee: { email: { equals: "jane@example.com", mode: "insensitive" } } },
      data: { userId: "u-exist" },
    });
    expect(mockDb.user.update).toHaveBeenCalledWith({
      where: { id: "u-exist" },
      data: { termsAcceptedAt: expect.any(Date), termsAcceptedIp: "1.2.3.4" },
    });
    expect(mockDb.user.create).not.toHaveBeenCalled();
  });

  it("existing user with terms already accepted: does NOT overwrite the stamp", async () => {
    mockDb.user.findFirst.mockResolvedValue({ id: "u-exist", role: "REGISTRANT", termsAcceptedAt: new Date() });
    await ensureRegistrantAccount(base);
    expect(mockDb.user.update).not.toHaveBeenCalled();
  });

  it("existing UNCONFIRMED account with the right password: links only this reg; others wait for a confirmation link", async () => {
    mockDb.user.findFirst.mockResolvedValue({ id: "u-exist", role: "REGISTRANT", termsAcceptedAt: new Date(), emailConfirmedAt: null, passwordHash: "h" });
    compareSpy.mockResolvedValue(true);
    mockDb.registration.findFirst.mockResolvedValue({ id: "older-guest-reg" });
    await ensureRegistrantAccount(base);
    expect(mockDb.registration.update).toHaveBeenCalledWith({ where: { id: "reg1" }, data: { userId: "u-exist" } });
    expect(mockDb.registration.updateMany).not.toHaveBeenCalled();
    expect(sendVerifySpy).toHaveBeenCalledWith({ email: "jane@example.com", name: "Jane Doe", purpose: "registrations", organizationId: "org1" });
  });

  it("new user with earlier registrations on the address: takes none of them, is sent a confirmation link", async () => {
    mockDb.registration.findFirst.mockResolvedValue({ id: "older-guest-reg" });
    await ensureRegistrantAccount(base);
    expect(mockDb.registration.update).toHaveBeenCalledWith({ where: { id: "reg1" }, data: { userId: "u-new" } });
    expect(mockDb.registration.updateMany).not.toHaveBeenCalled();
    expect(sendVerifySpy).toHaveBeenCalledWith({ email: "jane@example.com", name: "Jane Doe", purpose: "registrations", organizationId: "org1" });
  });

  it("new user: creates REGISTRANT, org-null for external, links only this registration, notifies", async () => {
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
    expect(mockDb.registration.update).toHaveBeenCalledWith({ where: { id: "reg1" }, data: { userId: "u-new" } });
    expect(mockDb.registration.updateMany).not.toHaveBeenCalled();
    expect(notifySpy).toHaveBeenCalledWith(
      "ev1",
      expect.objectContaining({ type: "SIGNUP", message: base.signupMessage }),
    );
    expect(sendVerifySpy).not.toHaveBeenCalled(); // nothing earlier to claim, not internal
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
    mockDb.user.findFirst.mockRejectedValue(new Error("db down"));
    await expect(ensureRegistrantAccount(base)).resolves.toBe("failed");
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "registrant-account:create-or-link-failed", registrationId: "reg1" }),
    );
  });
});

// The desk QR (docs/ONSITE_DESK_PLAN.md §8.3): an account with no password.
describe("withoutPassword", () => {
  it("makes the account with a random password nobody was given, and links the registration", async () => {
    await ensureRegistrantAccount({ ...base, password: undefined, withoutPassword: true });
    const hashed = hashSpy.mock.calls[0][0] as string;
    expect(hashed).toMatch(/^[0-9a-f]{64}$/);
    expect(mockDb.user.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ passwordHash: "hashed-pw", role: "REGISTRANT" }) }));
    expect(mockDb.registration.update).toHaveBeenCalledWith({ where: { id: "reg1" }, data: { userId: "u-new" } });
    expect(mockDb.registration.updateMany).not.toHaveBeenCalled();
  });

  it("an existing CONFIRMED account is linked, as with a password", async () => {
    mockDb.user.findFirst.mockResolvedValue({ id: "u-old", role: "REGISTRANT", termsAcceptedAt: new Date(), emailConfirmedAt: new Date() });
    await ensureRegistrantAccount({ ...base, password: undefined, withoutPassword: true });
    expect(mockDb.user.create).not.toHaveBeenCalled();
    expect(mockDb.registration.update).toHaveBeenCalledWith({ where: { id: "reg1" }, data: { userId: "u-old" } });
  });

  it("an existing UNCONFIRMED account is NOT handed the desk registration (whoever made it may not be this person)", async () => {
    mockDb.user.findFirst.mockResolvedValue({ id: "u-old", role: "REGISTRANT", termsAcceptedAt: new Date(), emailConfirmedAt: null });
    expect(await ensureRegistrantAccount({ ...base, password: undefined, withoutPassword: true })).toBe("none");
    expect(mockDb.registration.update).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.objectContaining({ msg: "registrant-account:existing-account-not-proven" }));
  });

  it("says what it did, so only an account it made is offered a password link", async () => {
    expect(await ensureRegistrantAccount({ ...base, password: undefined, withoutPassword: true })).toBe("created-without-password");
    expect(await ensureRegistrantAccount(base)).toBe("created");
    mockDb.user.findFirst.mockResolvedValueOnce({ id: "u-old", role: "REGISTRANT", termsAcceptedAt: new Date(), emailConfirmedAt: new Date() });
    expect(await ensureRegistrantAccount({ ...base, password: undefined, withoutPassword: true })).toBe("linked");
    mockDb.user.create.mockRejectedValueOnce(new Error("db down"));
    expect(await ensureRegistrantAccount({ ...base, password: undefined, withoutPassword: true })).toBe("failed");
  });

  it("still a no-op with no password and no flag (a guest)", async () => {
    expect(await ensureRegistrantAccount({ ...base, password: undefined })).toBe("none");
    expect(mockDb.user.create).not.toHaveBeenCalled();
    expect(mockDb.registration.update).not.toHaveBeenCalled();
  });
});

describe("an existing account takes a new registration only with proof (re-review of 5b870d59)", () => {
  it("a wrong password on an unconfirmed account leaves the registration unlinked", async () => {
    mockDb.user.findFirst.mockResolvedValue({ id: "u-x", role: "REGISTRANT", termsAcceptedAt: new Date(), emailConfirmedAt: null, passwordHash: "h" });
    expect(await ensureRegistrantAccount(base)).toBe("none");
    expect(mockDb.registration.update).not.toHaveBeenCalled();
  });

  it("linkOnly (the caller verified the signed-in session) links an unconfirmed account", async () => {
    mockDb.user.findFirst.mockResolvedValue({ id: "u-x", role: "REGISTRANT", termsAcceptedAt: new Date(), emailConfirmedAt: null });
    expect(await ensureRegistrantAccount({ ...base, password: undefined, withoutPassword: true, linkOnly: true })).toBe("linked");
  });
});
