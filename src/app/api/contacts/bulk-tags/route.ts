import { NextResponse } from "next/server";
import { z } from "zod";
import { db, tenantTransaction } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { getOrgContext } from "@/lib/api-auth";
import { denyReviewer } from "@/lib/auth-guards";
import { normalizeTag } from "@/lib/utils";

const bulkTagsSchema = z.object({
  // Cap keeps the sequential in-tx update loop bounded well under the 30s
  // transaction timeout (review LOW-1); dashboard selections are page-bound
  // and far below this — only an unbounded API-key payload could hit it.
  contactIds: z.array(z.string()).min(1).max(1000),
  tags: z.array(z.string().transform(normalizeTag)),
  // add: union new tags with existing (deduped)
  // remove: filter out specified tags from existing
  // replace: overwrite existing tags entirely
  mode: z.enum(["add", "remove", "replace"]),
});

export async function PATCH(req: Request) {
  try {
    const [ctx, body] = await Promise.all([getOrgContext(req), req.json()]);

    if (!ctx) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Blocks REVIEWER/SUBMITTER/REGISTRANT/MEMBER (single source of truth);
    // API-key auth (role null) passes through as admin-equivalent.
    const denied = denyReviewer({ user: { role: ctx.role ?? undefined } });
    if (denied) return denied;

    const validated = bulkTagsSchema.safeParse(body);
    if (!validated.success) {
        apiLogger.warn({ msg: "contacts/bulk-tags:zod-validation-failed", errors: validated.error.flatten() });
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const { contactIds, tags, mode } = validated.data;

    // Verify all contacts belong to this org
    const contacts = await db.contact.findMany({
      where: {
        id: { in: contactIds },
        organizationId: ctx.organizationId,
      },
      select: { id: true, tags: true },
    });

    if (contacts.length === 0) {
      return NextResponse.json({ error: "No contacts found" }, { status: 404 });
    }

    // tenantTransaction (tenancy pilot): the sanctioned interactive-tx wrapper
    // — with RLS_SET_LOCAL off (master) it is exactly db.$transaction.
    // Sequential per-row updates (per-row tag merges need per-row writes);
    // generous timeout so a large selection can't trip the 5s interactive
    // default the old array-form transaction never had.
    const results = await tenantTransaction(
      async (tx) => {
        const rows: { id: string; tags: string[] }[] = [];
        for (const contact of contacts) {
          let newTags: string[];
          if (mode === "add") {
            newTags = [...new Set([...contact.tags, ...tags])];
          } else if (mode === "remove") {
            const toRemove = new Set(tags);
            newTags = contact.tags.filter((t) => !toRemove.has(t));
          } else {
            newTags = tags;
          }
          rows.push(
            await tx.contact.update({
              // Compound where: ids come from the org-bound findMany above,
              // but the write itself stays org-bound too.
              where: { id: contact.id, organizationId: ctx.organizationId },
              data: { tags: newTags },
              select: { id: true, tags: true },
            })
          );
        }
        return rows;
      },
      // maxWait raised from the 2s interactive default toward the old
      // array-form's pool-queue patience (review LOW-1).
      { timeout: 30_000, maxWait: 10_000 }
    );

    return NextResponse.json({ updated: results.length, contacts: results });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error bulk-updating contact tags" });
    return NextResponse.json({ error: "Failed to update tags" }, { status: 500 });
  }
}
