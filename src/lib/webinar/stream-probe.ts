/**
 * Is MediaMTX serving the HLS stream for this key right now? One cached probe
 * shared by every caller in the container.
 *
 * At 5k viewers every LivePlayer polls stream-status about every 10 s; without
 * the cache each request would fire an outbound probe at the single MediaMTX
 * container (a self-DoS). A 3 s TTL collapses the fan-out to about one probe
 * per 3 s per box. Per-container (resets on deploy), which is fine for a
 * liveness flag. Also read by the room toggle (Oct 2, 2026), so opening the
 * room does not ask Zoom to start a stream the producer already started and
 * checked in the console preview.
 */
import { apiLogger } from "@/lib/logger";

const probeCache = new Map<string, { isLive: boolean; at: number }>();
const PROBE_TTL_MS = 3000;
/** An unreachable MediaMTX is logged at most this often per container, not on every probe. */
const UNREACHABLE_LOG_EVERY_MS = 60_000;
let lastUnreachableLogAt = 0;

export async function isStreamArriving(
  streamKey: string,
  opts: { fresh?: boolean } = {},
): Promise<boolean> {
  // `fresh` skips the cache: the room toggle acts on the answer, and a result
  // up to 3 s old could say "live" just after the producer pressed Stop.
  const cached = opts.fresh ? undefined : probeCache.get(streamKey);
  if (cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.isLive;
  const mediamtxUrl = process.env.MEDIAMTX_HLS_URL || "http://localhost:8888";
  let isLive = false;
  try {
    const res = await fetch(`${mediamtxUrl}/live/${streamKey}/index.m3u8`, {
      signal: AbortSignal.timeout(3000),
    });
    isLive = res.ok;
  } catch (err) {
    // MediaMTX unreachable (a 404 for an inactive stream is not an exception): treat as not live, and
    // say so. It used to be silent, which hid a worker that could never reach MediaMTX (Nov 5, 2026).
    const now = Date.now();
    if (now - lastUnreachableLogAt >= UNREACHABLE_LOG_EVERY_MS) {
      lastUnreachableLogAt = now;
      let host = "invalid-url";
      try {
        host = new URL(mediamtxUrl).host;
      } catch {
        // keep the placeholder
      }
      apiLogger.warn(
        { host, code: (err as { cause?: { code?: string } })?.cause?.code ?? (err as Error)?.name },
        "stream-probe:mediamtx-unreachable",
      );
    }
  }
  probeCache.set(streamKey, { isLive, at: Date.now() });
  return isLive;
}
