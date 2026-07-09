/**
 * Bundle-aware cover-email token resolution (multi-cert-per-email feature):
 *   - no bundle / 1-cert bundle → byte-identical to the historical singular
 *     tokens (regression pin).
 *   - 2+ certs → {{certificateType}} joins distinct labels,
 *     {{certificateSerial}} comma-joins, {{certificateList}} renders one
 *     line per cert with template-name disambiguation for same-category
 *     pairs, escaped on the HTML path.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: { abstract: { findFirst: vi.fn().mockResolvedValue(null) } },
}));
vi.mock("@/lib/logger", () => ({
  apiLogger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import {
  resolveCoverEmailTokens,
  type CoverEmailTokenContext,
} from "@/lib/certificates/email-tokens-resolver";

const baseCtx: CoverEmailTokenContext = {
  recipientName: "Dr Jane Doe",
  eventName: "IOHNC 2026",
  eventStartDate: new Date("2026-04-01T00:00:00Z"),
  eventEndDate: new Date("2026-04-03T00:00:00Z"),
  venue: null,
  city: null,
  country: null,
  organizationName: "Meeting Minds",
  certificateType: "ATTENDANCE",
  certificateSerial: "ATT-001",
  speakerId: null,
  eventId: "evt_1",
};

describe("resolveCoverEmailTokens — bundle context", () => {
  it("keeps singular tokens identical when no bundle is supplied", async () => {
    const out = await resolveCoverEmailTokens("{{certificateType}} / {{certificateSerial}}", baseCtx);
    expect(out).toBe("Certificate of Attendance / ATT-001");
  });

  it("renders {{certificateList}} as a single line without a bundle", async () => {
    const out = await resolveCoverEmailTokens("{{certificateList}}", baseCtx);
    expect(out).toBe("<p>Certificate of Attendance — ATT-001</p>");
  });

  it("joins distinct labels + serials for a 2-cert cross-category bundle", async () => {
    const ctx: CoverEmailTokenContext = {
      ...baseCtx,
      bundle: {
        certs: [
          { serial: "ATT-001", type: "ATTENDANCE", templateName: "Attendance" },
          { serial: "APP-002", type: "APPRECIATION", templateName: "Speaker" },
        ],
      },
    };
    const out = await resolveCoverEmailTokens("{{certificateType}} | {{certificateSerial}} | {{certificateList}}", ctx);
    expect(out).toContain("Certificate of Attendance & Certificate of Appreciation");
    expect(out).toContain("ATT-001, APP-002");
    expect(out).toContain("<p>Certificate of Attendance — ATT-001<br/>Certificate of Appreciation — APP-002</p>");
  });

  it("disambiguates two same-category certs with their template names", async () => {
    const ctx: CoverEmailTokenContext = {
      ...baseCtx,
      bundle: {
        certs: [
          { serial: "APP-001", type: "APPRECIATION", templateName: "Speaker" },
          { serial: "APP-002", type: "APPRECIATION", templateName: "Committee" },
        ],
      },
    };
    const out = await resolveCoverEmailTokens("{{certificateList}}", ctx);
    expect(out).toContain("Certificate of Appreciation (Speaker) — APP-001");
    expect(out).toContain("Certificate of Appreciation (Committee) — APP-002");
    // The single distinct label is NOT duplicated in {{certificateType}}.
    const type = await resolveCoverEmailTokens("{{certificateType}}", ctx);
    expect(type).toBe("Certificate of Appreciation");
  });

  it("escapes operator template names on the HTML path (escapeDynamic)", async () => {
    const ctx: CoverEmailTokenContext = {
      ...baseCtx,
      escapeDynamic: true,
      bundle: {
        certs: [
          { serial: "APP-001", type: "APPRECIATION", templateName: `<b>Bold</b>` },
          { serial: "APP-002", type: "APPRECIATION", templateName: "Committee" },
        ],
      },
    };
    const out = await resolveCoverEmailTokens("{{certificateList}}", ctx);
    expect(out).toContain("&lt;b&gt;Bold&lt;/b&gt;");
    expect(out).not.toContain("<b>Bold</b>");
  });
});
