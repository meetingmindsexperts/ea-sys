/**
 * Talking to MediaMTX's control API: who is publishing, and ending a publish
 * (Nov 12, 2026; external streams step 3, "cut the feed",
 * docs/EXTERNAL_STREAM_AND_PRERECORDED_PLAN.md §4.6).
 *
 * Why it exists: MediaMTX asks our publish check only when a stream STARTS. A
 * partner's encoder that connected while its key was good keeps its connection
 * after the key is replaced, switched off or past its period. With our own
 * Zoom we tell Zoom to stop; a partner's platform is not ours to tell. The
 * only way to end that stream is to disconnect it here.
 *
 * How it is reached:
 *  - MEDIAMTX_API_URL: the API's address inside the box's container network
 *    (http://ea-sys-mediamtx:9997). The port is never published on the box.
 *  - MEDIAMTX_API_SECRET: sent as the HTTP Basic password, user "ea-sys".
 *    MediaMTX has no password of its own here: with `authMethod: http` it asks
 *    OUR webhook whether an API call is allowed (action "api"), and the
 *    webhook compares the password it is shown with this secret. So a call
 *    without the secret is refused by our own code, whoever makes it.
 *
 * Both unset (local development, a box not yet set up): every function answers
 * NOT_CONFIGURED and nothing is attempted.
 *
 * It asks about PATHS, never about connections (review of 132b7d29). A path
 * exists in MediaMTX only while someone publishes to it, and a publish is
 * checked by our webhook BEFORE its path is made, so the number of paths is
 * the number of streams that are really live. The first version listed every
 * RTMP connection instead: MediaMTX counts a connection from the moment a TCP
 * socket opens on port 1935, so anyone could hold a thousand idle sockets
 * open, the list no longer fitted, and "cut the feed" failed for as long as
 * they kept it up. A path names its publisher's connection (`source.id`), so:
 *
 *   one stream   GET /v3/paths/get/live/<key>     one call, whatever else is
 *                                                 connected to the server
 *   everyone     GET /v3/paths/list               the minute sweep
 *   end it       POST /v3/rtmpconns/kick/<id>
 *   when begun   GET /v3/rtmpconns/get/<id>       only where a replaced key
 *                                                 has to be judged
 *
 * NOT VERIFIED AGAINST A RUNNING SERVER when written (the shapes and the
 * behaviour above are from MediaMTX 1.17.1's source and its OpenAPI file). So
 * it is written to fail safe: an answer it does not understand is BAD_ANSWER,
 * never "nobody is publishing", and it only ever disconnects the connection a
 * path named as its own publisher. docs/LIVE_STREAMING.md §11b has the owner's
 * check.
 *
 * Errors are values. Never logs a stream key or the secret.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { apiLogger } from "@/lib/logger";

export const MEDIAMTX_API_USER = "ea-sys";
const REQUEST_TIMEOUT_MS = 3000;
const PAGE_SIZE = 100;
/** 1,000 live streams: far above anything one box carries, and a bound on a misbehaving answer. */
const MAX_PAGES = 10;

export type ControlFailure = "NOT_CONFIGURED" | "UNREACHABLE" | "REFUSED" | "BAD_ANSWER";

export interface Publisher {
  /** The publishing connection's id, as its path names it. */
  id: string;
  /** Which kind of connection it is, and so which address ends it. */
  family: "rtmpconns" | "rtmpsconns";
  /** The MediaMTX path, e.g. "live/<streamKey>". */
  path: string;
}

export interface PublisherDetails {
  remoteAddr: string;
  /** When the connection began, or null when MediaMTX's answer did not say in a form we can read. */
  connectedAt: Date | null;
}

export type PublishersResult = { ok: true; publishers: Publisher[] } | { ok: false; code: ControlFailure };
export type DisconnectResult = { ok: true; disconnected: number } | { ok: false; code: ControlFailure; message: string };

export const CONTROL_FAILURE_MESSAGE: Record<ControlFailure, string> = {
  NOT_CONFIGURED: "The stream server's control address is not set up on this server.",
  UNREACHABLE: "The stream server did not answer.",
  REFUSED: "The stream server refused the request.",
  BAD_ANSWER: "The stream server's answer could not be read.",
};

/**
 * The webhook that checks the secret is a public address, so the secret must
 * be long enough that guessing it there is hopeless. A shorter one counts as
 * not set: nothing is called and no caller is accepted.
 */
export const MEDIAMTX_API_SECRET_MIN_LENGTH = 32;

function controlSecret(): string | null {
  const secret = process.env.MEDIAMTX_API_SECRET;
  return secret && secret.length >= MEDIAMTX_API_SECRET_MIN_LENGTH ? secret : null;
}

function config(): { base: string; secret: string } | null {
  const base = process.env.MEDIAMTX_API_URL;
  const secret = controlSecret();
  return base && secret ? { base: base.replace(/\/+$/, ""), secret } : null;
}

/** Whether the control API can be used at all: a partner's key is not issued until it can. */
export function isMediamtxControlConfigured(): boolean {
  return config() !== null;
}

/**
 * The webhook's question: is this API call ours? Compared as digests, so the
 * comparison takes the same time whatever the length of what was presented.
 */
export function isValidControlCaller(user: string | undefined | null, password: string | undefined | null): boolean {
  const secret = controlSecret();
  if (!secret || !password || user !== MEDIAMTX_API_USER) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(secret), digest(password));
}

async function call(
  path: string,
  method: "GET" | "POST",
  what: "list" | "path" | "connection" | "kick",
): Promise<{ status: number; json: unknown } | ControlFailure> {
  const cfg = config();
  if (!cfg) return "NOT_CONFIGURED";
  try {
    const res = await fetch(`${cfg.base}${path}`, {
      method,
      headers: { Authorization: `Basic ${Buffer.from(`${MEDIAMTX_API_USER}:${cfg.secret}`).toString("base64")}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const json: unknown = await res.json().catch(() => null);
    return { status: res.status, json };
  } catch (err) {
    apiLogger.warn(
      { code: (err as { cause?: { code?: string } })?.cause?.code ?? (err as Error)?.name, what },
      "mediamtx-control:unreachable",
    );
    return "UNREACHABLE";
  }
}

/** MediaMTX's own error body ({"status":"error","error":"..."}), as against some other server's 404. */
function isMediamtxError(json: unknown): boolean {
  return Boolean(json) && typeof json === "object" && typeof (json as { error?: unknown }).error === "string";
}

/** Go's zero time ("0001-01-01...") parses as a real date: nothing before this is a connection's start. */
const EARLIEST_PLAUSIBLE_START_MS = Date.UTC(2020, 0, 1);

function readDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  const ms = date.getTime();
  return Number.isNaN(ms) || ms < EARLIEST_PLAUSIBLE_START_MS ? null : date;
}

/** A path's `source.type` for the two kinds of connection we can end. */
const SOURCE_FAMILY: Record<string, Publisher["family"]> = { rtmpConn: "rtmpconns", rtmpsConn: "rtmpsconns" };

type PathSource =
  | { kind: "none" }
  | { kind: "rtmp"; family: Publisher["family"]; id: string }
  /** Something is publishing that is not an RTMP connection (every other protocol is switched off). */
  | { kind: "other"; type: string };

/** One path as MediaMTX describes it, or null when the answer is not a path we can read. */
function readPath(json: unknown): { name: string; source: PathSource } | null {
  if (!json || typeof json !== "object") return null;
  const raw = json as { name?: unknown; source?: unknown };
  if (typeof raw.name !== "string") return null;
  if (raw.source === null || raw.source === undefined) return { name: raw.name, source: { kind: "none" } };
  if (typeof raw.source !== "object") return null;
  const { type, id } = raw.source as { type?: unknown; id?: unknown };
  if (typeof type !== "string") return null;
  const family = SOURCE_FAMILY[type];
  if (!family) return { name: raw.name, source: { kind: "other", type } };
  if (typeof id !== "string" || !id) return null;
  return { name: raw.name, source: { kind: "rtmp", family, id } };
}

function readPage(json: unknown): { pageCount: number; items: unknown[] } | null {
  if (!json || typeof json !== "object") return null;
  const page = json as { pageCount?: unknown; items?: unknown };
  if (typeof page.pageCount !== "number" || !Array.isArray(page.items)) return null;
  return { pageCount: page.pageCount, items: page.items };
}

/** The status and the shape, never the content: enough to tell a changed API from a wrong address. */
function logNotUnderstood(what: "list" | "path" | "connection", answer: { status: number; json: unknown }): void {
  apiLogger.warn(
    { what, status: answer.status, answer: answer.json === null ? "not JSON" : typeof answer.json },
    "mediamtx-control:answer-not-understood",
  );
}

function publishersOf(items: unknown[]): Publisher[] | null {
  const publishers: Publisher[] = [];
  for (const item of items) {
    const path = readPath(item);
    if (!path) return null;
    if (path.source.kind === "rtmp") publishers.push({ id: path.source.id, family: path.source.family, path: path.name });
  }
  return publishers;
}

/** One page of the path list: its publishers and how many pages there are, or why not. */
async function listPage(
  page: number,
): Promise<{ ok: true; publishers: Publisher[]; pageCount: number } | { ok: false; code: ControlFailure }> {
  const answer = await call(`/v3/paths/list?itemsPerPage=${PAGE_SIZE}&page=${page}`, "GET", "list");
  if (typeof answer === "string") return { ok: false, code: answer };
  if (answer.status === 401 || answer.status === 403) return { ok: false, code: "REFUSED" };
  const read = answer.status === 200 ? readPage(answer.json) : null;
  // One path we cannot read fails the page: it could be the publisher that has to go.
  const publishers = read ? publishersOf(read.items) : null;
  if (!read || !publishers) {
    logNotUnderstood("list", answer);
    return { ok: false, code: "BAD_ANSWER" };
  }
  return { ok: true, publishers, pageCount: read.pageCount };
}

async function listPaths(): Promise<PublishersResult> {
  const publishers: Publisher[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const listed = await listPage(page);
    if (!listed.ok) return listed;
    publishers.push(...listed.publishers);
    if (page + 1 >= listed.pageCount) return { ok: true, publishers };
  }
  // More live paths than we read (review of a6ec7911): a publisher could be on
  // a page we never saw, and "nobody is publishing" would then be a guess.
  apiLogger.warn({ pages: MAX_PAGES }, "mediamtx-control:list-too-long");
  return { ok: false, code: "BAD_ANSWER" };
}

/** Everyone publishing to MediaMTX now: one entry per live path, with the connection that feeds it. */
export async function listPublishers(): Promise<PublishersResult> {
  const listed = await listPaths();
  if (!listed.ok && listed.code !== "NOT_CONFIGURED") apiLogger.warn({ code: listed.code }, "mediamtx-control:list-failed");
  return listed;
}

type PublisherOnPath = { ok: true; publisher: Publisher | null } | { ok: false; code: ControlFailure };

/**
 * Who is publishing to this one path, asked of the path itself: the answer does
 * not depend on how many other connections the server is holding.
 */
async function publisherOn(path: string): Promise<PublisherOnPath> {
  // The slash stays a slash: MediaMTX's route is /paths/get/*name.
  const answer = await call(`/v3/paths/get/${path.split("/").map(encodeURIComponent).join("/")}`, "GET", "path");
  if (typeof answer === "string") return { ok: false, code: answer };
  if (answer.status === 401 || answer.status === 403) return { ok: false, code: "REFUSED" };
  // 404 WITH MediaMTX's own error body: no such path, so nobody is publishing
  // to it. A bare 404 is a different server answering, and is not an answer.
  if (answer.status === 404 && isMediamtxError(answer.json)) return { ok: true, publisher: null };
  const read = answer.status === 200 ? readPath(answer.json) : null;
  if (!read || read.name !== path) {
    logNotUnderstood("path", answer);
    return { ok: false, code: "BAD_ANSWER" };
  }
  if (read.source.kind === "none") return { ok: true, publisher: null };
  if (read.source.kind === "other") {
    // A publisher we have no way to end. Never reported as "nobody".
    apiLogger.warn({ sourceType: read.source.type }, "mediamtx-control:publisher-not-rtmp");
    return { ok: false, code: "BAD_ANSWER" };
  }
  return { ok: true, publisher: { id: read.source.id, family: read.source.family, path } };
}

/**
 * Where a publisher connects from and when its connection began, or null when
 * MediaMTX did not say (the connection ended meanwhile, or an answer we cannot
 * read). Asked one connection at a time and only where it is needed: the
 * answer also carries what the encoder sent to get in, which is never read.
 */
export async function publisherDetails(publisher: Publisher): Promise<PublisherDetails | null> {
  const answer = await call(`/v3/${publisher.family}/get/${encodeURIComponent(publisher.id)}`, "GET", "connection");
  if (typeof answer === "string") return null;
  if (answer.status === 404 && isMediamtxError(answer.json)) return null;
  const raw = answer.status === 200 && answer.json && typeof answer.json === "object" ? answer.json : null;
  if (!raw) {
    logNotUnderstood("connection", answer);
    return null;
  }
  const conn = raw as { remoteAddr?: unknown; created?: unknown };
  return { remoteAddr: typeof conn.remoteAddr === "string" ? conn.remoteAddr : "", connectedAt: readDate(conn.created) };
}

/** End one publisher's connection. True when MediaMTX did it, or it was already gone. */
export async function kickPublisher(publisher: Publisher): Promise<boolean> {
  const answer = await call(`/v3/${publisher.family}/kick/${encodeURIComponent(publisher.id)}`, "POST", "kick");
  if (typeof answer === "string") return false;
  if (answer.status === 200) return true;
  // 404 WITH MediaMTX's own error body: the connection ended between the
  // question and the kick, which is the outcome wanted. A bare 404 is a different
  // server answering (an address or a version whose API moved), and counting
  // that as done would report a stream as cut while it is still running.
  if (answer.status === 404 && isMediamtxError(answer.json)) return true;
  apiLogger.warn({ status: answer.status }, "mediamtx-control:kick-refused");
  return false;
}

/**
 * Disconnect whoever is publishing on this stream key. `disconnected: 0` means
 * nobody was (a path has one publisher, so it is 0 or 1). The encoder may
 * reconnect at once, so a caller that wants the stream to STAY down switches
 * the key off first.
 */
export async function disconnectPublishers(streamKey: string): Promise<DisconnectResult> {
  const found = await publisherOn(`live/${streamKey}`);
  if (!found.ok) {
    if (found.code !== "NOT_CONFIGURED") apiLogger.warn({ code: found.code }, "mediamtx-control:find-publisher-failed");
    return { ok: false, code: found.code, message: CONTROL_FAILURE_MESSAGE[found.code] };
  }
  if (!found.publisher) return { ok: true, disconnected: 0 };
  if (!(await kickPublisher(found.publisher))) {
    apiLogger.warn({ found: 1, disconnected: 0 }, "mediamtx-control:disconnect-incomplete");
    return { ok: false, code: "REFUSED", message: "The stream server did not disconnect the stream." };
  }
  apiLogger.info({ disconnected: 1 }, "mediamtx-control:publisher-disconnected");
  return { ok: true, disconnected: 1 };
}
