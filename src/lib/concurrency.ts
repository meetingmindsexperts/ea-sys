/**
 * Bounded-concurrency map — run an async `fn` over `items` with at most
 * `limit` in flight at once, preserving result order.
 *
 * Why (check-in/badges review H4): "Print All" rendered every barcode with a
 * bare `Promise.all(registrations.map(...))`, firing up to ~2000 simultaneous
 * CPU-bound `bwip-js.toBuffer` rasterizations. That pins the single box's Node
 * event loop for the whole render — and that box also serves the live check-in
 * scanner and the Stripe webhook, so a "Print All" during the arrival rush
 * stalls the door. Capping the in-flight count lets the loop breathe between
 * renders so latency-critical requests still get served.
 *
 * No external dependency (production is live — avoid casual deps). This is a
 * minimal pool, not a full scheduler; it does not support cancellation.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const effectiveLimit = Math.max(1, Math.min(limit, items.length));
  let next = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: effectiveLimit }, () => worker()));
  return results;
}
