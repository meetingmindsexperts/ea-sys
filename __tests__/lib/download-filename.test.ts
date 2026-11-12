/**
 * A download named after text a person typed (an event's slug or code) must
 * not fail on a letter outside Latin-1 (Nov 12, 2026). Found on the local copy
 * of production: the certificate recipients CSV answered 500 for the event
 * whose slug is "AβTC2026", because `new Response` refuses such a header.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { contentDisposition } from "@/lib/download-filename";

describe("contentDisposition", () => {
  it("the failure it prevents: a raw non-Latin-1 name makes the response itself throw", () => {
    expect(() => new Response("", { headers: { "Content-Disposition": 'attachment; filename="certificate-recipients-AβTC2026.csv"' } })).toThrow(TypeError);
  });

  it("gives a header the response accepts, with a plain name and the real one", () => {
    const value = contentDisposition("certificate-recipients-AβTC2026.csv");
    const res = new Response("", { headers: { "Content-Disposition": value } });
    expect(res.headers.get("Content-Disposition")).toBe(
      "attachment; filename=\"certificate-recipients-A_TC2026.csv\"; filename*=UTF-8''certificate-recipients-A%CE%B2TC2026.csv",
    );
  });

  it("leaves a plain name as it was, so a page reading filename=\"...\" finds the same name as before", () => {
    const value = contentDisposition("hm2026-floor-plan-a3.pdf");
    expect(/filename="([^"]+)"/.exec(value)?.[1]).toBe("hm2026-floor-plan-a3.pdf");
    expect(value.endsWith("filename*=UTF-8''hm2026-floor-plan-a3.pdf")).toBe(true);
  });

  it("a quote or a backslash cannot close the name early", () => {
    const value = contentDisposition('a"b\\c.csv');
    expect(value.startsWith('attachment; filename="a_b_c.csv"; ')).toBe(true);
  });

  it("the encoded name holds only what RFC 5987 allows bare", () => {
    const encoded = contentDisposition("it's (a) *name*.csv").split("filename*=UTF-8''")[1];
    expect(encoded).toBe("it%27s%20%28a%29%20%2Aname%2A.csv");
  });

  it("inline when asked", () => {
    expect(contentDisposition("x.pdf", "inline").startsWith("inline; ")).toBe(true);
  });
});

describe("downloads named after an event's slug or code", () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name === "route.ts") files.push(path);
    }
  };
  walk(join(process.cwd(), "src/app/api"));

  it("none writes a slug or a code straight into the header", () => {
    const raw = files.flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => /Content-Disposition/.test(line) && !/contentDisposition\(/.test(line) && /\$\{[^}]*\.(slug|code)\b/.test(line))
        .map((line) => `${file}: ${line.trim()}`),
    );
    expect(raw).toEqual([]);
  });

  it("the seven that are named that way go through contentDisposition", () => {
    const using = files
      .filter((file) => /contentDisposition\(/.test(readFileSync(file, "utf8")))
      .map((file) => file.split("src/app/api/")[1])
      .sort();
    expect(using).toEqual([
      "events/[eventId]/certificates/recipients/route.ts",
      "events/[eventId]/certificates/runs/[runId]/download/route.ts",
      "events/[eventId]/export-bundle/route.ts",
      "events/[eventId]/invoices/export/route.ts",
      "events/[eventId]/venue/plan-pdf/route.ts",
      "events/[eventId]/venue/room-sheet/route.ts",
      "public/events/[slug]/floor-plan/[token]/pdf/route.ts",
    ]);
  });
});
