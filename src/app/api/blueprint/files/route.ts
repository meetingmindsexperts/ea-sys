/**
 * POST /api/blueprint/files (multipart, field `file`): store one upload and
 * answer `{ id, url, sizeBytes, contentType }`, the vendor page's contract.
 * Type decided from the bytes, 10 MB cap (blueprint-files.ts).
 */
import { NextResponse } from "next/server";
import { apiLogger } from "@/lib/logger";
import { runWithTenant } from "@/lib/tenant-context";
import { checkRateLimit } from "@/lib/security";
import { rateLimited } from "@/lib/api-errors";
import { blueprintErrorResponse, blueprintGuard } from "@/lib/blueprint/route-guard";
import { storeFile } from "@/services/blueprint-service";

const ROUTE = "blueprint/files:POST";
const LIMIT = { limit: 60, windowMs: 60 * 60_000 };

export async function POST(req: Request) {
  try {
    const gate = await blueprintGuard("blueprints.edit", ROUTE);
    if (!gate.ok) return gate.response;
    return await runWithTenant(gate.organizationId, async () => {
      const rl = checkRateLimit({ key: `blueprint-file:${gate.userId}`, ...LIMIT });
      if (!rl.allowed) return rateLimited(rl, { route: ROUTE, userId: gate.userId, limit: LIMIT.limit, windowSeconds: 3600 });

      const form = await req.formData().catch(() => null);
      const file = form?.get("file");
      if (!(file instanceof File)) {
        apiLogger.warn({ msg: `${ROUTE}:no-file`, userId: gate.userId });
        return NextResponse.json({ error: "Attach a file in the `file` field", code: "NO_FILE" }, { status: 400 });
      }
      const buffer = Buffer.from(await file.arrayBuffer());
      const result = await storeFile({ organizationId: gate.organizationId, userId: gate.userId }, { buffer, name: file.name });
      if (!result.ok) return blueprintErrorResponse(result);
      return NextResponse.json(result.file, { status: 201 });
    });
  } catch (err) {
    apiLogger.error({ err, msg: `${ROUTE}:failed` });
    return NextResponse.json({ error: "Failed to store the file" }, { status: 500 });
  }
}
