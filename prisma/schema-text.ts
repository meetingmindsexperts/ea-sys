/**
 * The whole Prisma schema as one string, for tests and tools that read the
 * schema TEXT (model blocks, @@map names). Since Sep 25, 2026 the schema is a
 * folder: prisma/schema.prisma (generator + datasource) plus one file per
 * domain in prisma/models/. Reading prisma/schema.prisma alone would now see
 * no models at all, so every reader goes through here.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function readPrismaSchema(root: string = process.cwd()): string {
  const dir = join(root, "prisma");
  const modelsDir = join(dir, "models");
  const files = [
    join(dir, "schema.prisma"),
    ...readdirSync(modelsDir)
      .filter((f) => f.endsWith(".prisma"))
      .sort()
      .map((f) => join(modelsDir, f)),
  ];
  return files.map((f) => readFileSync(f, "utf8")).join("\n");
}
