/**
 * Public doc links (September 25, 2026): which repo HTML docs open without
 * sign-in at /admin/docs/<path>, and the switch that changes it.
 *
 * GET  → { enabled, paths }: whether this deployment honours public links
 *        (master only) and the docs currently public, for the viewer's badges.
 * POST → { path, public }: make one HTML doc public or private again.
 *
 * PLATFORM OPERATOR only, like every other docs API: the viewer is the only
 * place these docs can be listed, and deciding what the public can read is a
 * platform decision. The rules live in src/lib/public-docs.ts.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { denyNonOperator } from "@/lib/platform-operator";
import { apiLogger } from "@/lib/logger";
import { zodErrorResponse } from "@/lib/api-errors";
import { listPublicDocPaths, publicDocLinksEnabled, setDocPublic } from "@/lib/public-docs";

const toggleSchema = z.object({
  path: z.string().trim().min(1).max(500),
  public: z.boolean(),
});

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const denied = denyNonOperator(session, { route: "admin-docs:public:list" });
    if (denied) return denied;
    return NextResponse.json({ enabled: publicDocLinksEnabled(), paths: await listPublicDocPaths() });
  } catch (error) {
    apiLogger.error({ err: error, msg: "admin-docs:public:list-failed" });
    return NextResponse.json({ error: "Failed to load public docs" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const session = await auth();
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const denied = denyNonOperator(session, { route: "admin-docs:public:set" });
    if (denied) return denied;

    const raw = await req.json().catch(() => null);
    if (raw === null) {
      apiLogger.warn({ msg: "admin-docs:public:invalid-json", userId: session.user.id });
      return NextResponse.json({ error: "Invalid JSON body", code: "INVALID_JSON" }, { status: 400 });
    }
    const parsed = toggleSchema.safeParse(raw);
    if (!parsed.success) {
      return zodErrorResponse(parsed, { route: "admin-docs:public:set", userId: session.user.id });
    }

    const result = await setDocPublic({ path: parsed.data.path, makePublic: parsed.data.public, userId: session.user.id });
    if (!result.ok) {
      const status = result.code === "NOT_FOUND" ? 404 : result.code === "DISABLED" ? 409 : 400;
      return NextResponse.json({ error: result.message, code: result.code }, { status });
    }
    return NextResponse.json({ path: result.path, public: result.public });
  } catch (error) {
    apiLogger.error({ err: error, msg: "admin-docs:public:set-failed" });
    return NextResponse.json({ error: "Failed to update the doc" }, { status: 500 });
  }
}
