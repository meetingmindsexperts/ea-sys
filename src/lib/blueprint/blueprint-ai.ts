/**
 * Run one Event Blueprint AI task: validate its input, build the server-held
 * prompt (ai-tasks.ts), ask Anthropic, return the parsed JSON answer.
 *
 * Calls the Anthropic SDK directly, like the Event Agent, because quick fill
 * can read a picture and the shared `AiProvider` is text only. The key is the
 * organisation's own when it has one, else the server's (`resolveAnthropicApiKey`).
 * Errors are values; every refusal and failure is logged with its code.
 */
import Anthropic from "@anthropic-ai/sdk";
import { apiLogger } from "@/lib/logger";
import { resolveAnthropicApiKey } from "@/lib/ai/credentials";
import { getModelConfig } from "@/lib/ai/config";
import { BLUEPRINT_AI_TASKS, TASK_INPUT, buildPrompt, tierFor, type BlueprintAiTask } from "./ai-tasks";
import { sniffBlueprintFile } from "./blueprint-files";

/** The vendor page sends at most one picture (quick fill); 5 MB is Anthropic's per-image limit. */
const MAX_IMAGES = 1;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export type BlueprintAiErrorCode = "UNKNOWN_TASK" | "INVALID_INPUT" | "INVALID_IMAGE" | "AI_UNAVAILABLE" | "INVALID_JSON";

export type BlueprintAiResult =
  | { ok: true; answer: Record<string, unknown> }
  | { ok: false; code: BlueprintAiErrorCode; message: string };

export interface BlueprintAiRequest {
  organizationId: string;
  userId: string;
  task: unknown;
  input: unknown;
  images?: unknown;
}

type ImageBlock = { type: "image"; source: { type: "base64"; media_type: "image/png" | "image/jpeg" | "image/webp" | "image/gif"; data: string } };

function fail(code: BlueprintAiErrorCode, message: string, ctx: Record<string, unknown>): BlueprintAiResult {
  const level = code === "AI_UNAVAILABLE" ? "error" : "warn";
  apiLogger[level]({ msg: "blueprint-ai:refused", code, ...ctx });
  return { ok: false, code, message };
}

function isTask(v: unknown): v is BlueprintAiTask {
  return typeof v === "string" && (BLUEPRINT_AI_TASKS as readonly string[]).includes(v);
}

/** The pictures as Anthropic image blocks, typed from their bytes; null when any is unacceptable. */
function toImageBlocks(raw: unknown): ImageBlock[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_IMAGES) return null;
  const blocks: ImageBlock[] = [];
  for (const img of raw) {
    const data = typeof img?.data === "string" ? img.data : "";
    const bytes = Buffer.from(data, "base64");
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) return null;
    const type = sniffBlueprintFile(bytes, "")?.contentType;
    if (!type || !IMAGE_TYPES.has(type)) return null;
    blocks.push({ type: "image", source: { type: "base64", media_type: type as ImageBlock["source"]["media_type"], data } });
  }
  return blocks;
}

/** The first JSON object in the reply, tolerating a ```json fence around it. */
export function parseJsonAnswer(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function runBlueprintAiTask(req: BlueprintAiRequest): Promise<BlueprintAiResult> {
  const ctx = { organizationId: req.organizationId, userId: req.userId, task: req.task };
  if (!isTask(req.task)) return fail("UNKNOWN_TASK", "Unknown AI task", ctx);
  const task = req.task;

  const parsed = TASK_INPUT[task].safeParse(req.input ?? {});
  if (!parsed.success) {
    return fail("INVALID_INPUT", "The request could not be used as sent", { ...ctx, errors: parsed.error.flatten() });
  }
  const images = task === "quickfill" ? toImageBlocks(req.images) : [];
  if (!images) return fail("INVALID_IMAGE", "One PNG, JPEG, WebP or GIF picture of at most 5 MB", ctx);

  const input = parsed.data as Record<string, unknown>;
  const tier = tierFor(task, input, images.length);
  const config = getModelConfig(tier === "quick" ? "blueprintQuick" : "blueprintDefault");
  const prompt = buildPrompt(task, input, images.length);

  let text: string;
  try {
    const client = new Anthropic({ apiKey: await resolveAnthropicApiKey(req.organizationId) });
    const started = Date.now();
    const message = await client.messages.create({
      model: config.model,
      max_tokens: config.maxTokens,
      temperature: config.temperature,
      messages: [{ role: "user", content: [...images, { type: "text", text: prompt }] }],
    });
    text = message.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    apiLogger.info({
      msg: "blueprint-ai:answered",
      ...ctx,
      tier,
      model: config.model,
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      stopReason: message.stop_reason,
      durationMs: Date.now() - started,
    });
  } catch (err) {
    apiLogger.error({ msg: "blueprint-ai:provider-failed", ...ctx, tier, err });
    return { ok: false, code: "AI_UNAVAILABLE", message: "The AI could not answer just now. Try again." };
  }

  const answer = parseJsonAnswer(text);
  if (!answer) return fail("INVALID_JSON", "The answer came back in the wrong shape. Try again.", { ...ctx, tier, length: text.length });
  return { ok: true, answer };
}
