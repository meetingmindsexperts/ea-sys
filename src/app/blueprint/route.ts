/**
 * GET /blueprint: the Event Blueprint page (docs/EVENT_BLUEPRINT_PLAN.md §4.1).
 *
 * Served as the vendor built it (vendor/event-blueprint, generated into
 * page-html.generated.ts by scripts/blueprint-build.mjs), outside the
 * dashboard shell and on our own origin, so the session cookie carries to
 * `/api/blueprint/*`. One script is injected before the page's own:
 * `window.EVENT_BLUEPRINT_BACKEND`, which switches the vendor adapter
 * (platform.js) into its API mode.
 *
 * AI stays off (`ai: false`) until the server owns the prompts (plan §4.6,
 * step 4): the vendor contract would forward any prompt the browser wrote.
 */
import { NextResponse } from "next/server";
import { apiLogger } from "@/lib/logger";
import { blueprintGuard } from "@/lib/blueprint/route-guard";
import { BLUEPRINT_PAGE_HTML_BASE64 } from "@/lib/blueprint/page-html.generated";

const ROUTE = "blueprint:page";

const BACKEND = { api: "/api/blueprint", ai: false, files: true };

const PAGE =
  '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">' +
  "<style>body{margin:0}[hidden]{display:none!important}</style></head><body>" +
  `<script>window.EVENT_BLUEPRINT_BACKEND=${JSON.stringify(BACKEND)};</script>` +
  Buffer.from(BLUEPRINT_PAGE_HTML_BASE64, "base64").toString("utf8") +
  "</body></html>";

const MESSAGES: Record<number, string> = {
  403: "You do not have access to the Event Blueprint. Ask an administrator.",
  404: "Not found.",
};

function plainPage(status: number): NextResponse {
  const text = MESSAGES[status] ?? "Something went wrong.";
  return new NextResponse(
    `<!doctype html><meta charset="utf-8"><title>Event Blueprint</title><p style="font:16px system-ui;margin:2rem">${text}</p>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

export async function GET(req: Request) {
  try {
    const gate = await blueprintGuard("blueprints.view", ROUTE);
    if (!gate.ok && gate.response.status === 401) {
      // Behind nginx `req.url` carries the container's own origin (it produced
      // https://0.0.0.0:3000/login on the docs route), so the public URL wins.
      const login = new URL("/login", process.env.NEXT_PUBLIC_APP_URL || new URL(req.url).origin);
      login.searchParams.set("callbackUrl", "/blueprint");
      return NextResponse.redirect(login);
    }
    if (!gate.ok) return plainPage(gate.response.status);
    return new NextResponse(PAGE, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    apiLogger.error({ err, msg: `${ROUTE}:failed` });
    return plainPage(500);
  }
}
