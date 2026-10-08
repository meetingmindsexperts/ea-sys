/**
 * AI attendees in the online venue (docs/EVENT_BLUEPRINT_PLAN.md §5.3, phase
 * 5B): the SERVER writes the instructions. The vendor page built them in the
 * browser (social.js `rules()`), which would let anyone signed in send their own
 * and use MM Group's Anthropic key as a free general-purpose AI. The page now
 * sends the persona's fields, the room and the conversation; every persona
 * field must be one the venue itself can produce (persona-vocab.generated.json,
 * read from the vendor source by scripts/venue-build.mjs), so nothing free-form
 * reaches the instructions. The wording below is the vendor's `rules()` and
 * `greeting()`, word for word, with the event's real name, dates and venue.
 */
import vocab from "./persona-vocab.generated.json";
import type { VenueLayout } from "./layout";

export type PersonaKind = "delegate" | "speaker" | "staff" | "society" | "exhibitor";

export interface Persona {
  first: string;
  last: string;
  name: string;
  short: string;
  title: string;
  org: string;
  kind: PersonaKind;
  trait: string;
  interest: string;
  arabic: boolean;
}

export interface Turn {
  role: "user" | "assistant";
  content: string;
}

/** Conversation limits: the page keeps 16 turns (social.js) and caps its input at 240 characters. */
export const MAX_TURNS = 16;
export const MAX_TURN_CHARS = 600;

const SPEAKER_SUFFIX = " and invited speaker";
/** makePersona's `arabic` test, word for word. */
const ARABIC = /^Al |Haddad|Khalil|Rahman|Yousef|Mansour|Barakat|Farouk|Saleh|Aziz|Qureshi/;
/** The speaker's reply to a question from the floor (abilities.js), the one greeting not built from the persona. */
export const FLOOR_GREETING = "Yes, a question from the floor? Go ahead, I’m listening.";

const NAMES = [...vocab.PEOPLE_NAMES.f, ...vocab.PEOPLE_NAMES.m];
const ZONES = vocab.ZONE_NAMES as Record<string, string>;
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown) => (typeof v === "string" ? v : "");

/** Delegates and speakers work at "<place> in <city>". */
const isPlaceInCity = (org: string) => vocab.PLACES.some((p) => vocab.CITIES.some((c) => `${p} in ${c}` === org));

/** The title's "Dr" flag, or null when the title is not one this kind of persona can have. */
function doctorFlag(kind: string, title: string): boolean | null {
  const plain = vocab.DELEGATE_TITLES.find(([t]) => t === title);
  if (plain) return !!plain[1];
  if (kind !== "speaker" || !title.endsWith(SPEAKER_SUFFIX)) return null;
  const invited = vocab.DELEGATE_TITLES.find(([t, dr]) => dr && t + SPEAKER_SUFFIX === title);
  return invited ? true : null;
}

/**
 * The persona the page sent, rebuilt from the venue's own lists, or null when
 * any field is one the venue cannot produce. The name and "Dr" come from the
 * title, never from what the page says.
 */
export function checkPersona(raw: unknown): Persona | null {
  const p = obj(raw);
  const [first, last, kind, title, org, trait, interest] = ["first", "last", "kind", "title", "org", "trait", "interest"].map((k) => str(p[k]));
  if (!NAMES.some(([f, l]) => f === first && l === last)) return null;
  if (!vocab.TRAITS.includes(trait) || !vocab.INTERESTS.includes(interest)) return null;

  let dr: boolean;
  if (vocab.ROLES.some((r) => r.title === title && r.org === org && r.kind === kind)) dr = false;
  else if ((kind === "delegate" || kind === "speaker") && isPlaceInCity(org)) {
    const flag = doctorFlag(kind, title);
    if (flag === null) return null;
    dr = flag;
  } else return null;

  return {
    first, last, title, org, trait, interest,
    kind: kind as PersonaKind,
    name: (dr ? "Dr " : "") + first + " " + last,
    short: dr ? "Dr " + last : first,
    arabic: ARABIC.test(last),
  };
}

/** The persona's own greeting (social.js `greeting()`). */
export function greetingFor(per: Persona): string {
  const hi = per.arabic ? "Ahlan wa sahlan! " : ["Hello! ", "Hi there! ", "Good morning! "][hashStr(per.name) % 3];
  if (per.kind === "staff") return hi + `I’m ${per.first} from ${per.org}. How can I help you?`;
  if (per.kind === "society") return hi + `I’m ${per.first}, volunteering at the society booth today. Are you a member?`;
  if (per.kind === "exhibitor") return hi + `I’m ${per.first}, on one of the partner stands. Enjoying the conference so far?`;
  return hi + `I’m ${per.name}, ${per.title.toLowerCase()} at ${per.org}. Nice to meet you.`;
}

/** social.js `hashStr` (FNV-1a), so the greeting picks the same "Hello" the page showed. */
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** The greeting the page showed, if it is one the venue produces; otherwise the persona's own. */
export function checkGreeting(raw: unknown, per: Persona): string {
  return raw === FLOOR_GREETING ? FLOOR_GREETING : greetingFor(per);
}

/**
 * The conversation as Anthropic takes it: the last 16 turns, each cut to 600
 * characters, empty ones dropped, neighbours of the same role joined, starting
 * and ending with the attendee. Null when nothing is left to answer.
 */
export function cleanTurns(raw: unknown): Turn[] | null {
  if (!Array.isArray(raw)) return null;
  const out: Turn[] = [];
  for (const t of raw.slice(-MAX_TURNS)) {
    const role = obj(t).role;
    const content = str(obj(t).content).trim().slice(0, MAX_TURN_CHARS);
    if ((role !== "user" && role !== "assistant") || !content) continue;
    const prev = out[out.length - 1];
    if (prev && prev.role === role) prev.content = (prev.content + "\n" + content).slice(0, MAX_TURN_CHARS * 2);
    else out.push({ role, content });
  }
  while (out.length && out[0].role !== "user") out.shift();
  return out.length && out[out.length - 1].role === "user" ? out : null;
}

export interface Scene {
  /** `organiser` and `specialty` are used only for a generated venue; EHC's own wording names its society. */
  event: { name: string; date: string; venue: string; organiser?: string; specialty?: string };
  /** The room the attendee is in (a ZONE_NAMES key, or a generated room's id), or "" for the venue. */
  zone: string;
  /** The event's generated venue (phase 6); absent for EHC's hand-built rooms. */
  layout?: VenueLayout;
  /** The AI attendee's pose and crowd role, as the page has them. */
  pose: string;
  role: string;
  greeting: string;
}

/** The room's name: from the generated venue when there is one, else from EHC's rooms. */
function roomName(scene: Scene): string | undefined {
  if (!scene.layout) return ZONES[scene.zone];
  return scene.layout.zones.find((z) => z.id === scene.zone && z.kind !== "corridor")?.name;
}

const KIND_WORDS: Record<string, string> = {
  plenary: "the main stage", hall: "parallel sessions", workshop: "hands-on sessions", posters: "abstract posters", exhibition: "partner stands", lounge: "a coffee bar and seats",
};

/** The generated building, in the words an attendee would use (the fixed plan of D10). */
export function describeVenue(layout: VenueLayout): string {
  const zones = layout.zones;
  const corridor = zones.find((z) => z.kind === "corridor");
  const foyer = zones.find((z) => z.kind === "foyer");
  const plenary = zones.find((z) => z.kind === "plenary");
  const side = (west: boolean) =>
    zones.filter((z) => !["foyer", "corridor", "plenary"].includes(z.kind) && corridor && (west ? z.rect[2] <= corridor.rect[0] + 0.01 : z.rect[0] >= corridor.rect[2] - 0.01));
  const list = (rooms: typeof zones) => rooms.map((z) => `${z.name} (${KIND_WORDS[z.kind] ?? z.kind})`).join(", ");
  const left = side(true);
  const right = side(false);
  return [
    `Venue you know: ${foyer?.name ?? "The foyer"} is the entrance, with registration and information desks; a main corridor runs from it`,
    plenary ? ` to ${plenary.name} (the main stage) at the far end.` : ".",
    left.length ? ` Along the left of the corridor: ${list(left)}.` : "",
    right.length ? ` Along the right: ${list(right)}.` : "",
  ].join("");
}

/** Where the AI attendee is and what they are doing (the `doing` line of `rules()`). */
function doing(scene: Scene): string {
  const where = roomName(scene) ?? "the venue";
  if (scene.pose === "sit") return `seated in the ${where}`;
  if (scene.role === "exhibitor") return `standing at your stand in the ${where}`;
  if (scene.role === "staff") return `behind the desk in the ${where}`;
  if (scene.role === "barista") return `behind the coffee bar in the ${where}`;
  return `standing in the ${where}`;
}

/** The instructions (social.js `rules()`), sent as the system prompt. */
export function buildInstructions(per: Persona, scene: Scene): string {
  const e = scene.event;
  if (scene.layout) return generatedInstructions(per, scene);
  return [
    `You are role-playing ONE fictional attendee inside a walkable 3D preview of the ${e.name}, organised by the ${vocab.ORGANISER} on ${e.date} at ${e.venue}. Another attendee has walked up to you and is talking to you; their messages follow.`,
    `You are ${per.name}, ${per.title}, from ${per.org}. Personality: ${per.trait}. ${per.kind === "delegate" || per.kind === "speaker" ? `Your main professional interest is ${per.interest}.` : ""} Right now you are ${doing(scene)}. You already greeted them with: "${scene.greeting}"`,
    `Venue you know: Grand Foyer with registration and information desks and a hanging disc sculpture; Plenary Ballroom (main stage) north of the foyer; Halls A, B and C and the Workshop Room on the west side, reached from the foyer and the Poster Gallery; the East Promenade leads to the Networking Lounge (coffee bar, city views) and the Exhibition Hall (host society booth, partner stands, a coffee point).`,
    `Not published in this preview: the session programme, track names, speakers, sponsor names and poster titles. Never invent them. If asked, say naturally that you don't have the programme in front of you and suggest the Venue guide or the information desk.`,
    `Rules: stay in character. Speak like a real person at a coffee break: 1 to 3 short sentences, no lists, no markdown, no emojis, no stage directions. Reply in the language they use (English or Arabic). General, educational haematology conversation is fine; give no personal medical advice, promote no drug, device or company, and make no product claims. You are fictional: never claim to be a real named person or name real colleagues. If asked whether you are an AI, say you are an AI-played attendee in this preview. Keep it friendly and professional.`,
    `After your sentences, on a new line, add exactly one tag [gesture: X] where X is one of nod, wave, laugh, think, point, shake, none. If you suggest they go somewhere, also add [go: Y] where Y is one of foyer, plenary, posters, hallA, hallB, hallC, workshop, lounge, expo.`,
  ].join("\n\n");
}

/**
 * The instructions for a generated venue: the vendor's wording, with the event's own organiser and
 * subject, the rooms this building has, and its room ids as the places to point people to.
 */
function generatedInstructions(per: Persona, scene: Scene): string {
  const e = scene.event;
  const layout = scene.layout!;
  const goIds = layout.zones.filter((z) => z.kind !== "corridor").map((z) => z.id);
  const subject = e.specialty?.trim() ? `${e.specialty.trim()} ` : "";
  return [
    `You are role-playing ONE fictional attendee inside a walkable 3D preview of the ${e.name}${e.organiser ? `, organised by ${e.organiser}` : ""}, on ${e.date} at ${e.venue}. Another attendee has walked up to you and is talking to you; their messages follow.`,
    `You are ${per.name}, ${per.title}, from ${per.org}. Personality: ${per.trait}. ${per.kind === "delegate" || per.kind === "speaker" ? `Your main professional interest is ${per.interest}.` : ""} Right now you are ${doing(scene)}. You already greeted them with: "${scene.greeting}"`,
    describeVenue(layout),
    `Not published in this preview: the session programme, track names, speakers, sponsor names and poster titles. Never invent them. If asked, say naturally that you don't have the programme in front of you and suggest the Venue guide or the information desk.`,
    `Rules: stay in character. Speak like a real person at a coffee break: 1 to 3 short sentences, no lists, no markdown, no emojis, no stage directions. Reply in the language they use (English or Arabic). General, educational ${subject}conversation is fine; give no personal medical advice, promote no drug, device or company, and make no product claims. You are fictional: never claim to be a real named person or name real colleagues. If asked whether you are an AI, say you are an AI-played attendee in this preview. Keep it friendly and professional.`,
    `After your sentences, on a new line, add exactly one tag [gesture: X] where X is one of nod, wave, laugh, think, point, shake, none. If you suggest they go somewhere, also add [go: Y] where Y is one of ${goIds.join(", ")}.`,
  ].join("\n\n");
}

