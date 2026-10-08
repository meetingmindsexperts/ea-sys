/**
 * GET    /api/blueprint/files/:id: stream one stored upload.
 * DELETE /api/blueprint/files/:id?blueprintId=: remove it from that blueprint.
 *
 * Served with a sandboxing CSP and nosniff, so a stored SVG (or anything
 * else) opened directly can never run script on our origin; images render
 * inline in the page's <img> previews, documents download.
 */
import { NextResponse } from "next/server";
import { apiLogger } from "@/lib/logger";
import { runWithTenant } from "@/lib/tenant-context";
import { blueprintErrorResponse, blueprintGuard } from "@/lib/blueprint/route-guard";
import { readFile, removeFile } from "@/services/blueprint-service";
import { isInlineType } from "@/lib/blueprint/blueprint-files";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  const ROUTE = "blueprint/files/[id]:GET";
  try {
    const [gate, { id }] = await Promise.all([blueprintGuard("blueprints.view", ROUTE), params]);
    if (!gate.ok) return gate.response;
    return await runWithTenant(gate.organizationId, async () => {
      const result = await readFile(gate.organizationId, id);
      if (!result.ok) return blueprintErrorResponse(result);
      return new NextResponse(new Uint8Array(result.body), {
        headers: {
          "Content-Type": result.contentType,
          "Content-Disposition": `${isInlineType(result.contentType) ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(result.name)}`,
          "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "private, max-age=300",
        },
      });
    });
  } catch (err) {
    apiLogger.error({ err, msg: `${ROUTE}:failed` });
    return NextResponse.json({ error: "Failed to read the file" }, { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: Params) {
  const ROUTE = "blueprint/files/[id]:DELETE";
  try {
    const [gate, { id }] = await Promise.all([blueprintGuard("blueprints.edit", ROUTE), params]);
    if (!gate.ok) return gate.response;
    return await runWithTenant(gate.organizationId, async () => {
      const blueprintId = new URL(req.url).searchParams.get("blueprintId") ?? "";
      const result = await removeFile({ organizationId: gate.organizationId, userId: gate.userId }, id, blueprintId);
      if (!result.ok) return blueprintErrorResponse(result);
      return NextResponse.json({ deleted: true, serverVersion: result.serverVersion });
    });
  } catch (err) {
    apiLogger.error({ err, msg: `${ROUTE}:failed` });
    return NextResponse.json({ error: "Failed to delete the file" }, { status: 500 });
  }
}
