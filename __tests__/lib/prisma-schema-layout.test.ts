/**
 * The split Prisma schema (Sep 25, 2026): a tripwire for the one failure that
 * matters. Prisma reads the prisma/ folder, and several Prisma releases around
 * the multi-file GA (6.6 to 6.14, and 7.0 when the config names a file) have
 * quietly read FEWER files than intended. A client generated from a partial
 * schema compiles, and a diff against it proposes dropping the missing tables.
 * CI's migration replay would also catch that; this catches it earlier and
 * says exactly which model went missing.
 *
 * It also pins the layout the research on known issues says to keep:
 * - every .prisma file is prisma/schema.prisma or prisma/models/*.prisma (a
 *   stray copy anywhere under prisma/ would be merged in silently, #27163);
 * - schema.prisma holds the generator and datasource and no models, and no
 *   area file holds a generator or datasource;
 * - prisma/migrations sits beside schema.prisma (move schema.prisma into a
 *   subfolder and `migrate deploy` stops finding migrations, #28215);
 * - package.json points Prisma at the folder, never at the file.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { Prisma, $Enums } from "@prisma/client";

const ROOT = process.cwd();
const PRISMA_DIR = join(ROOT, "prisma");

function prismaFilesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return prismaFilesUnder(full);
    return name.endsWith(".prisma") ? [relative(ROOT, full)] : [];
  });
}

const files = prismaFilesUnder(PRISMA_DIR).sort();
const text = (f: string) => readFileSync(join(ROOT, f), "utf8");
const blockNames = (kind: "model" | "enum") =>
  files.flatMap((f) => [...text(f).matchAll(new RegExp(`^${kind} (\\w+) \\{`, "gm"))].map((m) => m[1])).sort();

describe("the split Prisma schema", () => {
  it("has no .prisma file outside prisma/schema.prisma and prisma/models/", () => {
    const stray = files.filter((f) => f !== "prisma/schema.prisma" && !/^prisma\/models\/[^/]+\.prisma$/.test(f));
    expect(stray).toEqual([]);
    expect(files).toContain("prisma/schema.prisma");
  });

  it("keeps the generator and datasource in schema.prisma only, and no models there", () => {
    const main = text("prisma/schema.prisma");
    expect(main).toMatch(/^generator client \{/m);
    expect(main).toMatch(/^datasource db \{/m);
    expect(main).not.toMatch(/^(model|enum) \w+ \{/m);
    for (const f of files.filter((x) => x !== "prisma/schema.prisma")) {
      expect(text(f), f).not.toMatch(/^(generator|datasource) \w+ \{/m);
    }
  });

  it("keeps migrations beside the datasource file, and package.json points at the folder", () => {
    expect(existsSync(join(PRISMA_DIR, "migrations", "migration_lock.toml"))).toBe(true);
    const pkg = JSON.parse(text("package.json")) as { prisma?: { schema?: string } };
    expect(pkg.prisma?.schema).toBe("prisma");
  });

  it("generated a client with exactly the models in the files: none dropped, none extra", () => {
    const inFiles = blockNames("model");
    const inClient = Object.keys(Prisma.ModelName).sort();
    expect(inFiles.length).toBeGreaterThan(100);
    expect(inClient).toEqual(inFiles);
  });

  it("and exactly the enums in the files", () => {
    expect(Object.keys($Enums).sort()).toEqual(blockNames("enum"));
  });

  it("names every model and enum once across all files", () => {
    for (const kind of ["model", "enum"] as const) {
      const names = blockNames(kind);
      expect(names.filter((n, i) => names[i - 1] === n), kind).toEqual([]);
    }
  });
});
