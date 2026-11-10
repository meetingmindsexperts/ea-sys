/**
 * A webinar's uploaded replay: Vimeo link parsing (Nov 10, 2026).
 *
 * Zoom's cloud recording expires and its link can be forwarded, so the organiser uploads the
 * recording to the organisation's Vimeo account and pastes the video's link in the Webinar Console.
 * Vimeo only: there the video can be limited to embedding on this site, so it plays inside our
 * registration-gated page. A YouTube link has no such limit.
 *
 * Leaf module (`URL` and zod only), safe in client components and server routes. Host-allowlisted
 * like lobby-video.ts, and the embed address is built from the parsed id, never from the pasted
 * text, so a stored value can never become an arbitrary <iframe src>.
 */
import { z } from "zod";
import { VIMEO_HOSTS, VIMEO_ID_RE } from "@/lib/webinar/lobby-video";

const MAX_URL_LENGTH = 500;
/** The privacy hash of an unlisted video: vimeo.com/{id}/{hash}, or ?h={hash}. */
const VIMEO_HASH_RE = /^[0-9a-f]{8,40}$/i;

export interface ParsedReplayVideo {
  id: string;
  /** Present on an unlisted video; without it Vimeo refuses to play one. */
  hash: string | null;
  /** The player address: controls on, nothing autoplayed, no tracking cookie (`dnt`). */
  embedUrl: string;
}

/**
 * Where the video id sits in the path, or -1. One video only: a showcase, a live event, a folder
 * or a profile carries a number too, and embedding it as a video would show Vimeo's error page.
 */
function videoIdIndex(host: string, parts: string[]): number {
  if (host === "player.vimeo.com") return parts[0] === "video" ? 1 : -1;
  // vimeo.com/manage/videos/{id}, /showcase/{n}/video/{id}, /groups/{name}/videos/{id}
  const marker = Math.max(parts.lastIndexOf("video"), parts.lastIndexOf("videos"));
  if (marker >= 0) return marker + 1;
  // vimeo.com/channels/{name}/{id}
  if (parts[0] === "channels") return 2;
  // vimeo.com/{id} and vimeo.com/{id}/{hash}
  return 0;
}

/** A pasted Vimeo video link as a safe embed, or null for anything else. */
export function parseReplayVideo(raw: string | null | undefined): ParsedReplayVideo | null {
  if (!raw || typeof raw !== "string" || raw.length > MAX_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase();
  if (!VIMEO_HOSTS.has(host)) return null;

  const parts = url.pathname.split("/").filter(Boolean);
  const at = videoIdIndex(host, parts);
  const id = at >= 0 ? parts[at] : undefined;
  if (!id || !VIMEO_ID_RE.test(id)) return null;

  const candidate = url.searchParams.get("h") ?? parts[at + 1] ?? "";
  const hash = VIMEO_HASH_RE.test(candidate) ? candidate.toLowerCase() : null;
  const query = hash ? `h=${hash}&dnt=1` : "dnt=1";
  return { id, hash, embedUrl: `https://player.vimeo.com/video/${id}?${query}` };
}

export function isValidReplayUrl(raw: string | null | undefined): boolean {
  return parseReplayVideo(raw) !== null;
}

export const REPLAY_LINK_MESSAGE = "Must be a Vimeo video link, like https://vimeo.com/123456789";

/** The settings field: a Vimeo video link, or "" to clear it. */
export const replayLinkField = z
  .string()
  .trim()
  .max(MAX_URL_LENGTH)
  .refine((v) => v === "" || isValidReplayUrl(v), { message: REPLAY_LINK_MESSAGE });
