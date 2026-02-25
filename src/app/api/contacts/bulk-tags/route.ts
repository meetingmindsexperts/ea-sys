import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { getOrgContext } from "@/lib/api-auth";
import { normalizeTag } from "@/lib/utils";

const bulkTagsSchema = z.object({
  contactIds: z.array(z.string()).min(1),
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

    if (ctx.role === "REVIEWER" || ctx.role === "SUBMITTER") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const validated = bulkTagsSchema.safeParse(body);
    if (!validated.success) {
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

    const updates = contacts.map((contact) => {
      let newTags: string[];
      if (mode === "add") {
        newTags = [...new Set([...contact.tags, ...tags])];
      } else if (mode === "remove") {
        const toRemove = new Set(tags);
        newTags = contact.tags.filter((t) => !toRemove.has(t));
      } else {
        newTags = tags;
      }
      return db.contact.update({
        where: { id: contact.id },
        data: { tags: newTags },
        select: { id: true, tags: true },
      });
    });

    const results = await db.$transaction(updates);

    return NextResponse.json({ updated: results.length, contacts: results });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error bulk-updating contact tags" });
    return NextResponse.json({ error: "Failed to update tags" }, { status: 500 });
  }
}
