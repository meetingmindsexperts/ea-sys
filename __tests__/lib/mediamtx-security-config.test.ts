/**
 * MediaMTX exposure (Nov 5, 2026 security review, W-03). Every viewer's HLS URL contains the stream
 * key, so the stream server must check publishes with the app, listen only for what we use, and keep
 * HLS off the public interface. Source assertions: these files ARE the box's config.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const read = (f: string) => readFileSync(path.join(process.cwd(), f), "utf8");
const yml = read("mediamtx.yml");
const setting = (key: string) => yml.match(new RegExp(`^${key}:\\s*(\\S+)\\s*$`, "m"))?.[1];
const compose = read("docker-compose.prod.yml");
const mediamtxBlock = compose.slice(compose.indexOf("\n  mediamtx:"));
const portsBlock = mediamtxBlock.slice(mediamtxBlock.indexOf("ports:"), mediamtxBlock.indexOf("mem_limit:"));
const ports = [...portsBlock.matchAll(/^\s*-\s*"([^"]+)"/gm)].map((m) => m[1]);

describe("MediaMTX publish authorisation", () => {
  it("asks the app's webhook before every publish", () => {
    expect(setting("authMethod")).toBe("http");
    expect(setting("authHTTPAddress")).toBe("https://events.meetingmindsgroup.com/api/webhooks/mediamtx-auth");
  });

  it("excludes reads and playback only, so viewers never reach the app and publishes always do", () => {
    const exclude = yml.slice(yml.indexOf("authHTTPExclude:")).split(/\n(?=\S)/)[0];
    const actions = [...exclude.matchAll(/action:\s*(\S+)/g)].map((m) => m[1]).sort();
    expect(actions).toEqual(["playback", "read"]);
  });

  it("the container trusts the box's certificate authorities, or the HTTPS check fails and refuses every publish", () => {
    expect(setting("authHTTPAddress")).toMatch(/^https:/);
    expect(mediamtxBlock).toContain("- /etc/ssl/certs/ca-certificates.crt:/etc/ssl/certs/ca-certificates.crt:ro");
  });

  it("the webhook route exists where the config points", () => {
    expect(read("src/app/api/webhooks/mediamtx-auth/route.ts")).toContain("isValidPublishPassword");
  });
});

describe("MediaMTX listens only for RTMP in and HLS out", () => {
  it("RTSP, WebRTC and SRT are off: each also accepts publishes", () => {
    expect(setting("rtsp")).toBe("no");
    expect(setting("webrtc")).toBe("no");
    expect(setting("srt")).toBe("no");
    expect(setting("rtmp")).toBe("yes");
    expect(setting("hls")).toBe("yes");
  });

  it("publishes RTMP to the world and HLS on localhost only", () => {
    expect(ports.sort()).toEqual(["127.0.0.1:8888:8888", "1935:1935"]);
  });
});
