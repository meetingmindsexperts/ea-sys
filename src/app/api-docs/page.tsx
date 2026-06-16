import type { Metadata } from "next";
import { headers } from "next/headers";
import { Fraunces } from "next/font/google";
import { buildOpenApiSpec } from "@/lib/openapi-spec";
import { ApiReference } from "./api-reference";

/**
 * Public, self-hosted API reference for the EA-SYS REST API.
 *
 * Server component: it builds the OpenAPI spec on the server (same builder the
 * /api/openapi.json route uses) and hands it to a plain-React renderer — so the
 * page ships real, crawlable HTML with no browser-only widget and no CDN. This
 * replaces the @scalar/api-reference-react viewer, which didn't render in prod
 * and was the 105 MB build-weight that triggered INC-001.
 *
 * No auth to VIEW (sharing is the point); calling any endpoint still needs an
 * org API key. Lives outside the (dashboard) route group, so no app chrome.
 */

const apiDisplay = Fraunces({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-api-display",
  display: "swap",
});

export const metadata: Metadata = {
  title: "EA-SYS API Reference",
  description:
    "REST API for Meeting Minds Group / EA-SYS events — list events, faculty, the program, registrations, and contacts. API-key authenticated.",
};

export default async function ApiDocsPage() {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "https";
  const baseUrl =
    process.env.NEXT_PUBLIC_APP_URL ||
    (host ? `${proto}://${host}` : "https://events.meetingmindsgroup.com");

  const spec = buildOpenApiSpec(baseUrl) as unknown as Record<string, unknown>;

  return (
    <div className={apiDisplay.variable}>
      <ApiReference spec={spec} baseUrl={baseUrl} />
    </div>
  );
}
