import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";

export async function GET() {
  const start = Date.now();

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
        version: process.env.npm_package_version ?? "0.1.0",
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
      },
      {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      }
    );
  }
}
