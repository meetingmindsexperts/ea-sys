/**
 * AI key changes leave a trail, and the trail holds no keys (Nov 4, 2026
 * integrations review, INT-6). Source assertions in the shape of
 * zoom-credentials-audit.test.ts: what a row records is fixed here, so a
 * later edit cannot quietly start writing the key it was given.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(process.cwd(), "src/app/api/organization/ai/credentials/route.ts"), "utf8");

describe("AI credential audit", () => {
  it("records a row on save and on delete", () => {
    expect(src).toContain('"UPDATE_AI_CREDENTIALS"');
    expect(src).toContain('"DELETE_AI_CREDENTIALS"');
  });

  it("records only that a key rotated, never the key or its ciphertext", () => {
    expect(src).toContain("anthropicApiKey: validated.data.anthropicApiKey ? { rotated: true } : null");
    expect(src).toContain("openaiApiKey: validated.data.openaiApiKey ? { rotated: true } : null");
    const auditCalls = src.split("audit(req").slice(1).map((s) => s.slice(0, s.indexOf(");")));
    for (const call of auditCalls) {
      expect(call).not.toMatch(/apiKeyEncrypted|encryptSecret|slice\(-4\)/);
    }
  });

  it("does not let a failed audit write break a successful save", () => {
    expect(src).toContain("void db.auditLog");
    expect(src).toContain("ai:credentials-audit-failed");
  });
});
