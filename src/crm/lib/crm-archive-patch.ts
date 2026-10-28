/**
 * Archive / restore through PATCH is its own operation (Oct 28, 2026). It is
 * gated more tightly than a field edit and the routes run it alone, so a body
 * like { archived: false, name: "New" } used to restore the record, drop the
 * name and answer 200. Now the mixed body is refused with a 400 that names the
 * fields, and the caller sends them in a second request.
 *
 * Pure (zod only): used as a superRefine on each CRM PATCH schema.
 */
import type { z } from "zod";

export function archiveAlone(data: Record<string, unknown>, ctx: z.RefinementCtx): void {
  if (data.archived === undefined) return;
  const others = Object.entries(data)
    .filter(([k, v]) => k !== "archived" && v !== undefined)
    .map(([k]) => k);
  if (others.length === 0) return;
  ctx.addIssue({
    code: "custom",
    path: ["archived"],
    message: `Archive or restore on its own; send ${others.join(", ")} in a separate request`,
  });
}
