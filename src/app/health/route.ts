/**
 * Public health probe at /health (no /api prefix) — same payload as
 * /api/health. The shorter URL is what external monitoring tools
 * usually default to (Uptime Robot, StatusCake, AWS Route 53 health
 * checks all expect /health). Keeping /api/health alongside means
 * any existing checks that already point at the longer URL keep
 * working.
 *
 * Just re-exports the same GET handler — single source of truth.
 * No auth, no caching, returns 200 when DB is reachable, 503 when
 * it isn't (so load balancers can deregister us cleanly).
 */

export { GET } from "@/app/api/health/route";
