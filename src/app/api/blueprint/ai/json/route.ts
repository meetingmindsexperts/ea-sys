/**
 * POST /api/blueprint/ai/json { task, input, images? }: one of the Blueprint's
 * named AI tasks (concepts, spaces, programme, segments, quickfill), answered
 * as JSON. The prompt is built on the server (src/lib/blueprint/ai-tasks.ts);
 * the page can name a task, never write an instruction.
 *
 * Writers only (`blueprints.edit`): the AI fills in a blueprint. 40 calls an
 * hour per person, each capped in tokens by the model config.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { apiLogger } from "@/lib/logger";
import { runWithTenant } from "@/lib/tenant-context";
import { checkRateLimit } from "@/lib/security";
import { rateLimited } from "@/lib/api-errors";
import { blueprintGuard } from "@/lib/blueprint/route-guard";
import { runBlueprintAiTask } from "@/lib/blueprint/blueprint-ai";

const ROUTE = "blueprint/ai/json:POST";
const LIMIT = { limit: 40, windowMs: 60 * 60_000 };

/** Shape only; each task validates its own input (ai-tasks.ts TASK_INPUT). */
const bodySchema = z.object({
  task: z.string().max(40),
  input: z.record(z.string(), z.unknown()).optional(),
  images: z.array(z.object({ type: z.string().max(60), data: z.string() })).max(1).optional(),
});

const STATUS: Record<string, number> = {
  UNKNOWN_TASK: 400,
  INVALID_INPUT: 400,
  INVALID_IMAGE: 400,
  INVALID_JSON: 502,
  AI_UNAVAILABLE: 502,
};

export async function POST(req: Request) {
  try {
    const gate = await blueprintGuard("blueprints.edit", ROUTE);
    if (!gate.ok) return gate.response;
    return await runWithTenant(gate.organizationId, async () => {
      const rl = checkRateLimit({ key: `blueprint-ai:${gate.userId}`, ...LIMIT });
      if (!rl.allowed) return rateLimited(rl, { route: ROUTE, userId: gate.userId, limit: LIMIT.limit, windowSeconds: 3600 });

      const body = await req.json().catch(() => null);
      const parsed = bodySchema.safeParse(body);
      if (!parsed.success) {
        apiLogger.warn({ msg: `${ROUTE}:invalid-body`, userId: gate.userId, errors: parsed.error.flatten() });
        return NextResponse.json({ error: "Invalid input", code: "INVALID_INPUT" }, { status: 400 });
      }
      const result = await runBlueprintAiTask({
        organizationId: gate.organizationId,
        userId: gate.userId,
        task: parsed.data.task,
        input: parsed.data.input,
        images: parsed.data.images,
      });
      if (!result.ok) return NextResponse.json({ error: result.message, code: result.code }, { status: STATUS[result.code] ?? 400 });
      return NextResponse.json(result.answer);
    });
  } catch (err) {
    apiLogger.error({ err, msg: `${ROUTE}:failed` });
    return NextResponse.json({ error: "The AI could not answer just now." }, { status: 500 });
  }
}
