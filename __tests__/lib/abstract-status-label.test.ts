/**
 * The word shown for an abstract's status (owner, Nov 20, 2026): a rejected
 * abstract reads "Not accepted". Only the word: what other systems read is
 * the stored status.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { abstractStatusLabel, abstractStatusWords } from "@/lib/abstract-status-label";

describe("abstractStatusLabel", () => {
  it("a rejected abstract reads NOT ACCEPTED; the others read as stored, with spaces", () => {
    expect(abstractStatusLabel("REJECTED")).toBe("NOT ACCEPTED");
    expect(abstractStatusLabel("ACCEPTED")).toBe("ACCEPTED");
    expect(abstractStatusLabel("UNDER_REVIEW")).toBe("UNDER REVIEW");
    expect(abstractStatusLabel("REVISION_REQUESTED")).toBe("REVISION REQUESTED");
  });

  it("in sentence case for menus and tiles", () => {
    expect(abstractStatusWords("REJECTED")).toBe("Not accepted");
    expect(abstractStatusWords("UNDER_REVIEW")).toBe("Under review");
    expect(abstractStatusWords("ACCEPTED")).toBe("Accepted");
  });

  // The API, the services, the assistant's tools and the exports answer other systems (the website sync, a
  // spreadsheet someone filters, a connected assistant): they must go on saying REJECTED.
  it("is a display word only: nothing that answers another system imports it", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(entry.name) && /abstract-status-label|abstractStatusLabel|abstractStatusWords/.test(readFileSync(path, "utf8"))) hits.push(path);
      }
    };
    for (const root of ["src/app/api", "src/services", "src/lib/agent/tools", "worker"]) walk(join(process.cwd(), root));
    expect(hits).toEqual([]);
  });
});
