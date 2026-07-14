import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { getBuildInfo } from "@/lib/build-info";

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
      },
      {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      }
    );
  }
}
