/**
 * {{honorarium}} in the shared speaker email context (Sep 3, 2026).
 *
 * buildSpeakerEmailContext is the ONE source every speaker send reads (bulk,
 * single, previews, the agreement merge, the .docx fields), so the fee is
 * pinned here once: formatted, split into amount + currency, "0.00" when
 * none is agreed, and resolvable through mergeAgreementHtml.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    speaker: { findFirst: vi.fn() },
    event: { findFirst: vi.fn() },
  },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/logger", () => ({
  apiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { buildSpeakerEmailContext, mergeAgreementHtml } from "@/lib/speaker-agreement";

function speakerRow(honorariumAmount: unknown, honorariumCurrency: string | null) {
  return {
    title: "DR",
    firstName: "Jane",
    lastName: "Doe",
    email: "jane@x.com",
    jobTitle: "Consultant",
    organization: "Tawam Hospital",
    country: "UAE",
    honorariumAmount,
    honorariumCurrency,
    sessions: [
      {
        role: "SPEAKER",
        session: {
          name: "Opening Keynote",
          startTime: new Date("2026-03-05T05:00:00Z"),
          endTime: new Date("2026-03-05T06:00:00Z"),
          location: null as string | null,
          track: null,
          topics: [] as unknown[],
        },
      },
    ],
    topicSpeakers: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.event.findFirst.mockResolvedValue({
    name: "Cardio Summit",
    slug: "cardio",
    startDate: new Date("2026-03-05T00:00:00Z"),
    endDate: new Date("2026-03-06T00:00:00Z"),
    timezone: "Asia/Dubai",
    venue: null,
    address: null,
    city: null,
    organization: { name: "MMG" },
  });
});

describe("buildSpeakerEmailContext — honorarium fields", () => {
  it("formats an agreed fee and splits amount + currency (Decimal arrives as a string)", async () => {
    mockDb.speaker.findFirst.mockResolvedValue(speakerRow("1500.00", "USD"));
    const ctx = await buildSpeakerEmailContext("evt1", "spk1");
    expect(ctx?.honorarium).toBe("USD 1,500.00");
    expect(ctx?.honorariumAmount).toBe("1500.00");
    expect(ctx?.honorariumCurrency).toBe("USD");
  });

  it("accepts a Decimal-like object (toString) and rounds to 2dp", async () => {
    mockDb.speaker.findFirst.mockResolvedValue(
      speakerRow({ toString: () => "2500.5" }, "AED"),
    );
    const ctx = await buildSpeakerEmailContext("evt1", "spk1");
    expect(ctx?.honorarium).toBe("AED 2,500.50");
    expect(ctx?.honorariumAmount).toBe("2500.50");
  });

  it("no agreed fee renders as 0, never as a blank (owner: unset shows as 0)", async () => {
    mockDb.speaker.findFirst.mockResolvedValue(speakerRow(null, null));
    const ctx = await buildSpeakerEmailContext("evt1", "spk1");
    expect(ctx?.honorarium).toBe("0.00");
    expect(ctx?.honorariumAmount).toBe("0.00");
    expect(ctx?.honorariumCurrency).toBe("");
  });

  it("an amount with a currency the form cannot pay in reads as not set", async () => {
    mockDb.speaker.findFirst.mockResolvedValue(speakerRow("900.00", "EUR"));
    const ctx = await buildSpeakerEmailContext("evt1", "spk1");
    expect(ctx?.honorarium).toBe("0.00");
  });

  it("resolves {{honorarium}} + parts in the agreement HTML merge", async () => {
    mockDb.speaker.findFirst.mockResolvedValue(speakerRow("1500.00", "USD"));
    const ctx = await buildSpeakerEmailContext("evt1", "spk1");
    const html = mergeAgreementHtml(
      "<p>Fee: {{honorarium}} ({{honorariumAmount}} {{honorariumCurrency}})</p>",
      ctx!,
    );
    expect(html).toContain("Fee: USD 1,500.00 (1500.00 USD)");
    expect(html).not.toContain("{{");
  });
});
