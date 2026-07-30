import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { getBuildInfo } from "@/lib/build-info";
import { readEventLoopStats } from "@/lib/event-loop-monitor";

export async function GET() {
  const start = Date.now();
  // `version` alone ("0.4.x") is the same string across dozens of deploys, so it
  // could never answer the first question of any incident. gitSha + slot can:
  // this is also what deploy.sh's health gate hits, so a bad promote is now
  // attributable to a specific commit AND a specific slot.
  const build = getBuildInfo();

  try {
    // Check database connectivity
    await db.$queryRaw`SELECT 1`;

    return NextResponse.json(
      {
        status: "healthy",
        database: "connected",
        responseTimeMs: Date.now() - start,
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV ?? "unknown",
        version: build.version,
        gitSha: build.gitSha,
        gitShaShort: build.gitShaShort,
        builtAt: build.builtAt,
        slot: build.slot,
        hostname: build.hostname,
        // Rolling ~60s window + since-boot worsts. Idle floor ≈ resolutionMs
        // (~10ms) — worry at p99 in the hundreds of ms / max in seconds.
        eventLoop: readEventLoopStats(),
      },
      {
        status: 200,
        headers: { "Cache-Control": "no-store" },
      }
    );
  } catch (error) {
    apiLogger.warn({ err: error, msg: "Health check failed: database unreachable" });
    return NextResponse.json(
      {
        status: "unhealthy",
        database: "disconnected",
        error: "Database connection failed",
        responseTimeMs: Date.now() - start,
        timestamp: new Date().toISOString(),
        // Identity on the FAILURE path too — an unhealthy slot is exactly when
        // you need to know which commit and which container you're looking at.
        gitSha: build.gitSha,
        gitShaShort: build.gitShaShort,
        slot: build.slot,
        hostname: build.hostname,
        // On the FAILURE path too — "DB unreachable" and "loop pinned" often
        // co-occur (a pinned loop starves the pool's acquire timers), and this
        // is exactly when you need to tell the two apart.
        eventLoop: readEventLoopStats(),
      },
      {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      }
    );
  }
}
