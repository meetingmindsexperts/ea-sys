/**
 * Whether this server can run a partner's stream (Nov 16, 2026): both the
 * dedicated publish secret and the stream server's control address, or the
 * "streamed by a partner" choice is not offered.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ secret: true, control: true }));
vi.mock("@/lib/webinar/livestream", () => ({ isPartnerPublishSecretSet: () => h.secret }));
vi.mock("@/lib/webinar/mediamtx-control", () => ({ isMediamtxControlConfigured: () => h.control }));

import { partnerStreamReadiness } from "@/lib/webinar/partner-stream-readiness";

beforeEach(() => {
  h.secret = true;
  h.control = true;
});

describe("partnerStreamReadiness", () => {
  it("ready only with both", () => {
    expect(partnerStreamReadiness()).toEqual({ ready: true, missing: [] });
  });

  it("names what is missing", () => {
    h.secret = false;
    expect(partnerStreamReadiness()).toEqual({ ready: false, missing: ["STREAM_PUBLISH_SECRET"] });
    h.control = false;
    expect(partnerStreamReadiness()).toEqual({ ready: false, missing: ["STREAM_PUBLISH_SECRET", "MEDIAMTX_CONTROL"] });
    h.secret = true;
    expect(partnerStreamReadiness()).toEqual({ ready: false, missing: ["MEDIAMTX_CONTROL"] });
  });

  it("the client-safe file no longer holds a switch, and never reads the environment", async () => {
    const { readFileSync } = await import("node:fs");
    const file = readFileSync("src/lib/webinar/partner-stream-availability.ts", "utf8");
    expect(file).not.toContain("PARTNER_STREAM_CHOICE_OFFERED =");
    expect(file).not.toContain("process.env");
  });
});
