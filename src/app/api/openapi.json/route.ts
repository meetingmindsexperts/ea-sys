import { NextResponse } from "next/server";
import { buildOpenApiSpec } from "@/lib/openapi-spec";

/**
 * Public OpenAPI 3.1 document for the EA-SYS REST API. No auth — it's the
 * spec, not the data. The `servers[0].url` is the public app origin so
 * "Try it" in the Scalar viewer (and external tools) hit the right host.
 */
export async function GET(req: Request): Promise<Response> {
  const serverUrl = process.env.NEXT_PUBLIC_APP_URL || new URL(req.url).origin;
  const spec = buildOpenApiSpec(serverUrl);
  const res = NextResponse.json(spec);
  // Allow external API tools (Postman, SwaggerHub, etc.) to fetch the spec.
  res.headers.set("Access-Control-Allow-Origin", "*");
  res.headers.set("Cache-Control", "public, max-age=300");
  return res;
}
