/**
 * The Event Blueprint's AI tasks, with their prompts held on the SERVER
 * (docs/EVENT_BLUEPRINT_PLAN.md §4.6).
 *
 * The vendor page built each prompt in the browser and posted it whole, so a
 * signed-in user could have sent our AI key any instruction at all. Now the
 * page names a task and sends that task's data; the prompt is built here from
 * a fixed template. The page's own data (the brief, the organiser's words) is
 * still embedded, so what comes back can only be a suggestion for this form,
 * capped in size, in a JSON answer the page re-sanitises before showing.
 *
 * The templates are the vendor's text, word for word (app.js `ask(...)` call
 * sites and `qfPrompt()`), so the answers the page expects are unchanged. The
 * option lists come from the vendor's own data via catalogs.generated.ts.
 */
import { z } from "zod";
import { BLUEPRINT_CATALOGS as C } from "./catalogs.generated";

export const BLUEPRINT_AI_TASKS = ["concepts", "spaces", "programme", "segments", "quickfill"] as const;
export type BlueprintAiTask = (typeof BLUEPRINT_AI_TASKS)[number];

/** A brief is the page's `briefFor()` object: its own fields, capped in size. */
const MAX_BRIEF_BYTES = 32 * 1024;
const brief = z
  .record(z.string(), z.unknown())
  .refine((b) => new TextEncoder().encode(JSON.stringify(b)).length <= MAX_BRIEF_BYTES, "The brief is too large");

export const TASK_INPUT = {
  concepts: z.object({ brief }),
  spaces: z.object({ brief }),
  programme: z.object({ brief, spaceNames: z.array(z.string().max(120)).max(60) }),
  segments: z.object({ brief }),
  quickfill: z.object({
    words: z.string().max(20000).default(""),
    docText: z.string().max(60000).default(""),
    fileName: z.string().max(200).default(""),
  }),
} as const;

export type TaskInput<T extends BlueprintAiTask> = z.infer<(typeof TASK_INPUT)[T]>;

/** Which model tier answers: the vendor's own choice per call, decided here instead. */
export function tierFor(task: BlueprintAiTask, input: Record<string, unknown>, imageCount: number): "quick" | "default" {
  if (task === "concepts") return "default";
  if (task !== "quickfill") return "quick";
  const words = typeof input.words === "string" ? input.words.length : 0;
  const docText = typeof input.docText === "string" ? input.docText.length : 0;
  return words + docText > 4000 || imageCount > 0 ? "default" : "quick";
}

const RULES =
  'Use roles ("keynote speaker", "headline act", "host") instead of names. Never invent real people, sponsors, brands or venues. Keep it feasible for the format, budget and audience given, and true to this kind of event.';

const join = (xs: readonly string[], sep: string) => xs.join(sep);

/** The prompt for a task, from its validated input. */
export function buildPrompt(task: BlueprintAiTask, input: Record<string, unknown>, imageCount: number): string {
  const briefJson = JSON.stringify(input.brief ?? {});
  switch (task) {
    case "concepts":
      return `You are a senior event creative director and producer who works across every kind of event: launches, galas, festivals, conferences, weddings, exhibitions and more. Propose 3 clearly different concepts for the event in this brief. Ground them in the brief, honour must-haves and things to avoid, and fit the format and budget. ${RULES}\n\nBrief (JSON): ${briefJson}\n\nReply with only JSON: {"concepts":[{"name":"short concept name","bigIdea":"two sentences","feeling":"one line: how people feel when they leave","signature":"the one moment people will remember","mood":["word","word","word"],"spaces":[{"name":"","purpose":"","layout":"","cap":"","area":""}],"programme":[{"time":"","title":"","space":"","who":"role"}],"online":"one sentence: what makes the online version special"}]}\nEach concept: 4 to 7 spaces and 5 to 9 programme items. Spaces in the programme must match the space names. Mood words, where they fit, should come from: ${join(C.MOODS, ", ")}.`;
    case "spaces":
      return `You are an experienced event producer and spatial designer. Suggest the spaces (rooms or zones) this event needs, in the order a guest meets them. ${RULES}\n\nBrief (JSON): ${briefJson}\n\nReply with only JSON: {"spaces":[{"name":"","purpose":"one line","layout":"one of: ${join(C.LAYOUT_NAMES, " | ")}","cap":"number of people"}]} with 4 to 9 spaces.`;
    case "programme":
      return `You are an experienced show caller and event producer. Draft a realistic run of show for this event, using only these spaces: ${JSON.stringify(input.spaceNames ?? [])}. ${RULES}\n\nBrief (JSON): ${briefJson}\n\nReply with only JSON: {"programme":[{"time":"HH:MM","title":"","space":"one of the spaces","who":"role"}]} with 6 to 12 items in time order.`;
    case "segments":
      return `Estimate the audience mix for this event as 3 to 6 groups that add up to 100%. ${RULES}\n\nBrief (JSON): ${briefJson}\n\nReply with only JSON: {"segments":[{"label":"","pct":0}]}`;
    case "quickfill":
      return quickfillPrompt(String(input.words ?? ""), String(input.docText ?? ""), String(input.fileName ?? ""), imageCount > 0);
  }
}

function quickfillPrompt(words: string, docText: string, fileName: string, hasImage: boolean): string {
  return `You are filling in an event planning form from the organiser's own words and documents. The event can be of any kind. Extract only what the text states or clearly implies. Never invent names, dates, numbers, venues or sponsors. Leave out anything not covered. For fields with fixed options, copy one option exactly or leave the field out.

Fixed options:
type: ${C.TYPES.map((t) => t.id + " (" + t.n + ")").join("; ")}
path: twin (an event that exists or already happened), new (a new idea), both (a new event, in person and online)
format: ${join(C.FORMATS, " | ")}
goals: ${join(C.GOALS, " | ")}
mood: ${join(C.MOODS, " | ")}
languages: ${join(C.LANGS, " | ")}
look.style: ${join(C.LOOKS, " | ")}
look.setting: ${join(C.SETTINGS, " | ")}
online.features: ${join(C.FEATURES, " | ")}
online.access: ${join(C.ACCESS, " | ")}
partners.regulated: ${join(C.REGULATED, " | ")}
partner tier: Title | Platinum | Gold | Silver | Bronze | Exhibitor | Media | Supporter

Reply with only JSON in this shape, omitting unknown keys:
{"type":"","path":"","format":"","basics":{"title":"","host":"","purpose":"","when":"","duration":"","location":"","attendance":"","audience":"","languages":[],"budget":"","success":""},"concept":{"goals":[],"bigIdea":"","feeling":"","signature":"","mood":[],"mustHave":"","avoid":""},"spaces":[{"name":"","purpose":"","cap":""}],"programme":[{"time":"","title":"","space":"","who":""}],"people":{"hosts":[{"name":"","role":""}],"segments":[{"label":"","pct":0}],"staff":""},"partners":{"has":"yes|no","regulated":"","list":[{"name":"","tier":"","notes":""}]},"look":{"style":[],"palette":"","venueKind":"real|imagined","venueName":"","dims":"","setting":""},"online":{"features":[],"access":""},"delivery":{"deadline":"YYYY-MM-DD","owner":"","approver":""}}

For a floor plan, list each room or zone as a space, with its size in "purpose" (for example "24 x 18 m, ceiling 6 m"), its floor area in square metres in "area" when known, and its layout in "layout" (one of: ${join(C.LAYOUT_NAMES, " | ")}); put overall notes in look.dims.
${words ? `\nThe organiser's own words:\n"""${words.slice(0, 20000)}"""` : ""}${docText ? `\n\nText of the document "${fileName}":\n"""${docText.slice(0, 60000)}"""` : ""}${hasImage ? `\n\nThe attached picture "${fileName}" is from the organiser: a programme, brochure, list or floor plan. Read it.` : ""}`;
}
