/**
 * Waiting-room holding video — YouTube / Vimeo URL parsing.
 *
 * We do NOT host webinar holding videos (no video upload exists, and a single
 * box can't serve a video to 5k viewers). Organizers paste a YouTube or Vimeo
 * link; we embed that provider's player in the lobby, so delivery scales on
 * their CDN, not ours.
 *
 * Leaf module — pure string parsing (`URL` only), safe to import from both
 * client components and server routes. Host-allowlisted: only YouTube/Vimeo
 * embeds are ever produced, so a pasted value can never become an arbitrary
 * <iframe src>.
 */

export type LobbyVideoProvider = "youtube" | "vimeo";

export interface ParsedLobbyVideo {
  provider: LobbyVideoProvider;
  id: string;
  /** Ready-to-use iframe src — autoplay, muted, looped, minimal chrome. */
  embedUrl: string;
}

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtu.be",
  "www.youtu.be",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);

const VIMEO_HOSTS = new Set([
  "vimeo.com",
  "www.vimeo.com",
  "player.vimeo.com",
]);

const YT_ID_RE = /^[A-Za-z0-9_-]{6,20}$/;
const VIMEO_ID_RE = /^\d{6,15}$/;

/** Extract the YouTube video id from any common URL shape. */
function youtubeId(u: URL): string | null {
  const host = u.hostname.toLowerCase();
  if (host === "youtu.be" || host === "www.youtu.be") {
    const id = u.pathname.split("/").filter(Boolean)[0];
    return id && YT_ID_RE.test(id) ? id : null;
  }
  // watch?v=ID
  const v = u.searchParams.get("v");
  if (v && YT_ID_RE.test(v)) return v;
  // /embed/ID , /live/ID , /shorts/ID , /v/ID
  const parts = u.pathname.split("/").filter(Boolean);
  if (parts.length >= 2 && ["embed", "live", "shorts", "v"].includes(parts[0])) {
    const id = parts[1];
    return id && YT_ID_RE.test(id) ? id : null;
  }
  return null;
}

/** Extract the Vimeo numeric id from any common URL shape. */
function vimeoId(u: URL): string | null {
  const parts = u.pathname.split("/").filter(Boolean);
  // vimeo.com/123456789  OR  player.vimeo.com/video/123456789
  for (const p of parts) {
    if (VIMEO_ID_RE.test(p)) return p;
  }
  return null;
}

/**
 * Parse a pasted YouTube/Vimeo URL into a safe embed. Returns null for any
 * non-allowlisted host or unrecognized shape (caller should reject).
 */
export function parseLobbyVideo(raw: string | null | undefined): ParsedLobbyVideo | null {
  if (!raw || typeof raw !== "string") return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase();

  if (YOUTUBE_HOSTS.has(host)) {
    const id = youtubeId(u);
    if (!id) return null;
    // loop on a single video requires playlist=<id>.
    const embedUrl = `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&mute=1&loop=1&playlist=${id}&controls=0&modestbranding=1&rel=0&playsinline=1`;
    return { provider: "youtube", id, embedUrl };
  }

  if (VIMEO_HOSTS.has(host)) {
    const id = vimeoId(u);
    if (!id) return null;
    const embedUrl = `https://player.vimeo.com/video/${id}?autoplay=1&muted=1&loop=1&background=1`;
    return { provider: "vimeo", id, embedUrl };
  }

  return null;
}

/** True when the URL is a recognizable YouTube/Vimeo link (for input validation). */
export function isValidLobbyVideoUrl(raw: string | null | undefined): boolean {
  return parseLobbyVideo(raw) !== null;
}
