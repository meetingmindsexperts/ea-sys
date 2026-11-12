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

describe("MediaMTX's control API (Nov 12, 2026: disconnecting a partner's stream)", () => {
  it("is on, and its questions go to the app's webhook: `api` is NOT excluded from the HTTP check", () => {
    expect(setting("api")).toBe("yes");
    expect(setting("apiAddress")).toBe(":9997");
    const exclude = yml.slice(yml.indexOf("authHTTPExclude:")).split(/\n(?=\S)/)[0];
    expect(exclude).not.toMatch(/action:\s*api/);
    expect(read("src/app/api/webhooks/mediamtx-auth/route.ts")).toContain("isValidControlCaller");
  });

  it("is never published on the box: only the containers reach it", () => {
    expect(ports.some((p) => p.includes("9997"))).toBe(false);
    expect(mediamtxBlock.slice(0, mediamtxBlock.indexOf("mem_limit:"))).not.toMatch(/^\s*-\s*"[^"]*9997/m);
  });

  it("each container that calls it is given its address: both web slots and the worker", () => {
    for (const service of ["ea-sys-blue", "ea-sys-green", "ea-sys-worker"]) {
      const start = compose.indexOf(`\n  ${service}:`);
      expect(start).toBeGreaterThan(-1);
      const next = compose.slice(start + 1).search(/\n  [a-z][a-z-]*:\n/);
      const block = compose.slice(start, start + 1 + next);
      expect(block).toContain("- MEDIAMTX_API_URL=http://ea-sys-mediamtx:9997");
      expect(block).toContain("env_file:");
    }
  });
});
