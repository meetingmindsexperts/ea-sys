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
const probeCache = new Map<string, { isLive: boolean; at: number }>();
const PROBE_TTL_MS = 3000;

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
  } catch {
    // MediaMTX unreachable or stream not active: treat as not live.
  }
  probeCache.set(streamKey, { isLive, at: Date.now() });
  return isLive;
}
