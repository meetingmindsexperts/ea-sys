"use client";

import dynamic from "next/dynamic";

/**
 * Public, interactive API reference for the EA-SYS REST API, rendered by
 * Scalar from the OpenAPI spec at /api/openapi.json. No auth to VIEW the docs
 * (an API key is still required to actually call any endpoint). Self-hosted —
 * no external CDN. Lives outside the (dashboard) route group so there's no
 * sidebar/app chrome.
 *
 * Scalar is a browser-only component (Vue under the hood), so we load it via
 * next/dynamic with ssr:false to keep it off the server render.
 */
const ApiReference = dynamic(
  () => import("@scalar/api-reference-react").then((m) => m.ApiReferenceReact),
  {
    ssr: false,
    loading: () => (
      <div style={{ padding: 48, fontFamily: "system-ui, sans-serif", color: "#475569" }}>
        Loading API reference…
      </div>
    ),
  },
);

export default function ApiDocsPage() {
  return (
    <ApiReference
      configuration={{
        url: "/api/openapi.json",
        // Use the modern Scalar layout + a clean theme.
        theme: "default",
        hideClientButton: false,
      }}
    />
  );
}
