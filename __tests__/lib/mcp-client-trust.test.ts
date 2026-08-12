import { describe, it, expect } from "vitest";
import { describeRedirectTarget } from "@/lib/mcp-client-trust";

/**
 * The consent screen's whole job is to tell an admin WHERE a grant is going.
 * These pin the two ways that goes wrong: calling a hostile host recognised,
 * and calling a legitimate one unrecognised (which trains people to click
 * through the warning, destroying it).
 */
describe("describeRedirectTarget", () => {
  it("recognises the real Claude callback", () => {
    const t = describeRedirectTarget("https://claude.ai/api/mcp/auth_callback");
    expect(t.origin).toBe("https://claude.ai");
    expect(t.host).toBe("claude.ai");
    expect(t.recognized).toBe(true);
    expect(t.insecure).toBe(false);
  });

  it("recognises subdomains of a known host", () => {
    expect(describeRedirectTarget("https://beta.claude.ai/cb").recognized).toBe(true);
    expect(describeRedirectTarget("https://console.anthropic.com/cb").recognized).toBe(true);
  });

  it("does NOT recognise a look-alike host that merely ends with the name", () => {
    // The classic mistake is a bare endsWith: "notclaude.ai" and
    // "claude.ai.evil.com" both pass it, and both are the attack.
    expect(describeRedirectTarget("https://notclaude.ai/cb").recognized).toBe(false);
    expect(describeRedirectTarget("https://claude.ai.evil.com/cb").recognized).toBe(false);
    expect(describeRedirectTarget("https://evilclaude.ai/cb").recognized).toBe(false);
    expect(describeRedirectTarget("https://anthropic.com.attacker.net/cb").recognized).toBe(false);
  });

  it("does not recognise an unrelated host", () => {
    const t = describeRedirectTarget("https://evil.example/callback");
    expect(t.origin).toBe("https://evil.example");
    expect(t.recognized).toBe(false);
  });

  it("is case-insensitive on the host", () => {
    expect(describeRedirectTarget("https://CLAUDE.AI/cb").recognized).toBe(true);
  });

  it("flags plain http as insecure, but not loopback", () => {
    expect(describeRedirectTarget("http://evil.example/cb").insecure).toBe(true);
    expect(describeRedirectTarget("http://localhost:3000/cb").insecure).toBe(false);
    expect(describeRedirectTarget("http://127.0.0.1:8080/cb").insecure).toBe(false);
  });

  it("fails towards the warning on an unparseable URI, never towards silence", () => {
    const t = describeRedirectTarget("not a url");
    expect(t.origin).toBeNull();
    expect(t.host).toBeNull();
    expect(t.recognized).toBe(false);
  });

  it("keeps the port in the origin so two services on one host are distinguishable", () => {
    expect(describeRedirectTarget("https://example.com:8443/cb").origin).toBe(
      "https://example.com:8443",
    );
  });
});
