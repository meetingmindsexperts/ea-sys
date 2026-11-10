/**
 * The uploaded replay's player frame (replay-player.tsx, Nov 10, 2026).
 *
 * A source pin, because no unit test can see the failure: without the `encrypted-media` permission
 * Vimeo's player loads, shows its controls, and answers Play with "Unable to play video". Found only
 * by pressing Play in a real browser; proved by removing the permission again in the same tab.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const source = fs.readFileSync(path.resolve(__dirname, "../../src/components/webinar/replay-player.tsx"), "utf8");
const allow = /allow="([^"]+)"/.exec(source)?.[1].split(";").map((p) => p.trim()) ?? [];

describe("ReplayPlayer: the frame's permissions", () => {
  it("grants encrypted-media, without which Vimeo refuses to play in a frame", () => {
    expect(allow).toContain("encrypted-media");
  });

  it("grants fullscreen through `allow`, and does not also set allowFullScreen (the browser warns)", () => {
    expect(allow).toContain("fullscreen");
    expect(source).not.toMatch(/^\s*allowFullScreen/m);
  });

  it("sends the referrer: Vimeo's embed-on-this-site-only setting reads it", () => {
    expect(source).toContain('referrerPolicy="strict-origin-when-cross-origin"');
  });
});
