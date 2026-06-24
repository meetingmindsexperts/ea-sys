/**
 * P1.2 — cert cover-email `{{abstractTitle}}` must be HTML-escaped on the
 * HTML-body path. abstractTitle is speaker-authored (untrusted) and is
 * fetched INSIDE resolveCoverEmailTokens, so the caller's pre-escaped
 * context can't reach it — the `escapeDynamic` flag closes that gap.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const findFirst = vi.fn();

vi.mock("@/lib/db", () => ({
  db: { abstract: { findFirst: (...args: unknown[]) => findFirst(...args) } },
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
  certificateType: "APPRECIATION",
  certificateSerial: "APP-001",
  speakerId: "spk_1",
  eventId: "evt_1",
};

const MALICIOUS = `<script>alert(1)</script> & "quotes" 'apos'`;

beforeEach(() => {
  findFirst.mockReset();
  // First findFirst (POSTER) returns null, second (any ACCEPTED) returns the title.
  findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ title: MALICIOUS });
});

describe("resolveCoverEmailTokens — abstractTitle escaping", () => {
  it("escapes abstractTitle on the HTML-body path (escapeDynamic: true)", async () => {
    const out = await resolveCoverEmailTokens("<p>Talk: {{abstractTitle}}</p>", {
      ...baseCtx,
      escapeDynamic: true,
    });
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(out).toContain("&amp;");
    expect(out).toContain("&quot;quotes&quot;");
    expect(out).toContain("&#39;apos&#39;");
    // No raw tag survives into the HTML body.
    expect(out).not.toContain("<script>");
  });

  it("leaves abstractTitle raw on the subject/text path (escapeDynamic falsy)", async () => {
    const out = await resolveCoverEmailTokens("Talk: {{abstractTitle}}", baseCtx);
    // Plain-text path must NOT double-escape — raw value passes through.
    expect(out).toContain("<script>alert(1)</script>");
    expect(out).not.toContain("&lt;script&gt;");
  });
});
