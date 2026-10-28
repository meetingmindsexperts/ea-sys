/**
 * Archive / restore through PATCH runs alone (Oct 28, 2026): a mixed body
 * used to restore the record, drop the other fields and answer 200.
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { archiveAlone } from "@/crm/lib/crm-archive-patch";

const schema = z
  .object({ name: z.string().optional(), tags: z.array(z.string()).optional(), archived: z.boolean().optional() })
  .superRefine(archiveAlone);

describe("archiveAlone", () => {
  it("refuses archive or restore mixed with field edits, naming the fields", () => {
    const res = schema.safeParse({ archived: false, name: "New", tags: [] });
    expect(res.success).toBe(false);
    expect(res.error?.issues[0]).toMatchObject({ path: ["archived"] });
    expect(res.error?.issues[0]?.message).toContain("name, tags");
  });

  it("allows archive or restore alone, and edits alone", () => {
    expect(schema.safeParse({ archived: false }).success).toBe(true);
    expect(schema.safeParse({ archived: true }).success).toBe(true);
    expect(schema.safeParse({ name: "New" }).success).toBe(true);
  });

  it("ignores keys sent as undefined", () => {
    expect(schema.safeParse({ archived: false, name: undefined }).success).toBe(true);
  });
});
