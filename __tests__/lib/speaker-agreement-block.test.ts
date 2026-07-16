/**
 * {{agreementBlock}} helpers (speaker-agreement.ts) — the merged
 * invitation+agreement feature (July 16, 2026): a one-liner + "Review &
 * Agree" CTA exposed as a template variable, minted on demand.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    $transaction: vi.fn(),
    verificationToken: { deleteMany: vi.fn(), create: vi.fn() },
  },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({
  apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import {
  buildAgreementBlock,
  mintSpeakerAgreementLink,
  templateUsesAgreementBlock,
} from "@/lib/speaker-agreement";

describe("templateUsesAgreementBlock", () => {
  it("detects any of the three agreement tokens in any template part", () => {
    expect(templateUsesAgreementBlock("<p>{{agreementBlock}}</p>", null, "")).toBe(true);
    expect(templateUsesAgreementBlock("", "hi", "{{agreementBlockText}}")).toBe(true);
    expect(templateUsesAgreementBlock('<a href="{{agreementLink}}">go</a>')).toBe(true);
  });

  it("is false for templates with no agreement token — the mint gate", () => {
    expect(templateUsesAgreementBlock("<p>{{presentationDetails}}</p>", "{{message}}")).toBe(false);
    expect(templateUsesAgreementBlock(null, undefined, "")).toBe(false);
  });
});

describe("buildAgreementBlock", () => {
  it("renders the Review & Agree CTA for an unsigned speaker with a link", () => {
    const block = buildAgreementBlock({ agreementLink: "https://x.com/e/osh/speaker-agreement?token=abc" });
    expect(block.html).toContain("Review &amp; Agree");
    expect(block.html).toContain("https://x.com/e/osh/speaker-agreement?token=abc");
    expect(block.html).toContain("speaker agreement");
    expect(block.text).toContain("https://x.com/e/osh/speaker-agreement?token=abc");
  });

  it("renders an already-accepted note (no CTA) for a signed speaker", () => {
    const block = buildAgreementBlock({
      agreementLink: "https://x.com/should-not-appear",
      agreementAcceptedAt: new Date("2026-07-01T10:00:00Z"),
    });
    expect(block.html).toContain("already reviewed and accepted");
    expect(block.html).not.toContain("should-not-appear");
    expect(block.text).toContain("already reviewed and accepted");
  });

  it("renders empty when there is no link and no acceptance", () => {
    expect(buildAgreementBlock({ agreementLink: "" })).toEqual({ html: "", text: "" });
  });
});

describe("mintSpeakerAgreementLink", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.$transaction.mockResolvedValue([]);
    process.env.NEXT_PUBLIC_APP_URL = "https://events.example.com";
    // hashVerificationToken peppers with NEXTAUTH_SECRET and throws without it.
    process.env.NEXTAUTH_SECRET = "test-secret";
  });

  it("rotates the token (delete + create in one transaction) and returns the public URL", async () => {
    const url = await mintSpeakerAgreementLink("spk-1", "osh-2026");
    expect(mockDb.$transaction).toHaveBeenCalledTimes(1);
    expect(mockDb.verificationToken.deleteMany).toHaveBeenCalledWith({
      where: { identifier: "speaker-agreement:spk-1" },
    });
    const created = mockDb.verificationToken.create.mock.calls[0][0].data;
    expect(created.identifier).toBe("speaker-agreement:spk-1");
    // Stored token is the HASH, never the raw token from the URL.
    const rawToken = url.split("token=")[1];
    expect(rawToken).toMatch(/^[0-9a-f]{64}$/);
    expect(created.token).not.toBe(rawToken);
    expect(url).toBe(`https://events.example.com/e/osh-2026/speaker-agreement?token=${rawToken}`);
  });

  // Review M1 (July 16): agreementBlock-driven sends (invitation/custom) must
  // NOT invalidate a previously-delivered agreement link — they mint
  // additively, sweeping only EXPIRED rows.
  it("rotate: false mints additively — only expired tokens are swept", async () => {
    await mintSpeakerAgreementLink("spk-1", "osh-2026", { rotate: false });
    const where = mockDb.verificationToken.deleteMany.mock.calls[0][0].where;
    expect(where.identifier).toBe("speaker-agreement:spk-1");
    expect(where.expires).toEqual({ lt: expect.any(Date) });
    expect(mockDb.verificationToken.create).toHaveBeenCalledTimes(1);
  });

  it("rotate: true (explicit) deletes ALL existing tokens — strict re-send wins", async () => {
    await mintSpeakerAgreementLink("spk-1", "osh-2026", { rotate: true });
    expect(mockDb.verificationToken.deleteMany).toHaveBeenCalledWith({
      where: { identifier: "speaker-agreement:spk-1" },
    });
  });
});
