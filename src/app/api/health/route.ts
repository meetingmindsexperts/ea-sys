import { NextResponse } from "next/server";
import { db } from "@/lib/db";

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
    return NextResponse.json(
      {
        status: "unhealthy",
        database: "disconnected",
        error: error instanceof Error ? error.message : "Unknown error",
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
