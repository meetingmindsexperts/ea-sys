/**
 * GET the purchase order as a PDF (need "view"), rendered on demand from the
 * stored row, never in bulk (build plan §1.2); 60 renders an hour per person
 * because pdfkit is CPU on the box that serves the door.
 */
import { NextResponse, type NextRequest } from "next/server";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { rateLimited } from "@/lib/api-errors";
import { checkRateLimit } from "@/lib/security";
import { HTTP_STATUS_FOR_COMMITMENT_ERROR, guardedRead, procurementGuard, rejected } from "@/procurement/lib/route-helpers";
import { renderOrderPdf } from "@/procurement/services/commitment-service";

type Params = { params: Promise<{ commitmentId: string }> };
const ROUTE = "procurement/commitments/[commitmentId]/pdf";

export async function GET(_req: NextRequest, { params }: Params) {
  const [g, { commitmentId }] = await Promise.all([procurementGuard({ route: ROUTE, need: "view" }), params]);
  if (!g.ok) return g.response;
  const rl = checkRateLimit({ key: `procurement-pdf:${g.user.id}`, limit: 60, windowMs: 60 * 60 * 1000 });
  if (!rl.allowed) return rateLimited(rl, { route: ROUTE, userId: g.user.id, limit: 60, windowSeconds: 3600 });
  return runWithTenant(g.orgId, () => guardedRead(ROUTE, g.user.id, async () => {
    const result = await renderOrderPdf(g.orgId, commitmentId);
    if (!result.ok) return rejected(ROUTE, g.user.id, result, HTTP_STATUS_FOR_COMMITMENT_ERROR);
    apiLogger.info({ msg: `${ROUTE}:rendered`, commitmentId, bytes: result.pdf.length, userId: g.user.id });
    return new NextResponse(new Uint8Array(result.pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${result.commitmentNo}.pdf"`,
        "Cache-Control": "private, no-store",
      },
    });
  }));
}
