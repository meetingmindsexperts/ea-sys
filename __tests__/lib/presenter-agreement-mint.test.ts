/**
 * mintPresenterAgreementLink: ONE mint for the abstract card's send (rotate:
 * replaces the author's earlier links) and a bulk send carrying
 * {{presenterAgreementLink}} (additive: clears only expired tokens).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    verificationToken: { deleteMany: vi.fn((a) => ({ op: "deleteMany", a })), create: vi.fn((a) => ({ op: "create", a })) },
    $transaction: vi.fn(async (ops: unknown[]) => ops),
  },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));

import { mintPresenterAgreementLink, PRESENTER_AGREEMENT_IDENTIFIER_PREFIX } from "@/lib/presenter-agreement";

beforeEach(() => {
  vi.clearAllMocks();
  // Token hashing needs a secret; CI has no .env (two reds from this class, Sep 17/18).
  vi.stubEnv("NEXTAUTH_SECRET", "test-secret-for-presenter-mint");
});

describe("mintPresenterAgreementLink", () => {
  it("rotating replaces every earlier token for the author and returns a public accept link", async () => {
    const link = await mintPresenterAgreementLink("sp1", "mehf2027", { rotate: true });
    expect(mockDb.verificationToken.deleteMany).toHaveBeenCalledWith({ where: { identifier: `${PRESENTER_AGREEMENT_IDENTIFIER_PREFIX}sp1` } });
    expect(link).toMatch(/\/e\/mehf2027\/presenter-agreement\?token=[0-9a-f]{64}$/);
    const stored = mockDb.verificationToken.create.mock.calls[0][0].data;
    expect(stored.identifier).toBe("presenter-agreement:sp1");
    expect(link).not.toContain(stored.token);
  });

  it("additive clears only expired tokens, so a link already sent keeps working", async () => {
    await mintPresenterAgreementLink("sp1", "mehf2027", { rotate: false });
    const where = mockDb.verificationToken.deleteMany.mock.calls[0][0].where;
    expect(where.identifier).toBe("presenter-agreement:sp1");
    expect(where.expires.lt).toBeInstanceOf(Date);
  });
});
