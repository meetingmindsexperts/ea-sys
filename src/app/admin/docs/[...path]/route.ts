/**
 * GET /admin/docs/<repo-relative-path>
 *
 * Serves a repo doc DIRECTLY as a browser page — the shareable-URL
 * counterpart of the /admin/docs viewer, e.g.:
 *
 *   https://events.meetingmindsgroup.com/admin/docs/CODE_REVIEW_REGISTRATIONS_SPEAKERS.html
 *   https://events.meetingmindsgroup.com/admin/docs/docs/ROLLBACK.md
 *   https://events.meetingmindsgroup.com/admin/docs/CLAUDE.md
 *
 * Convenience resolution: the path is tried as-given (repo-relative) first;
 * if that misses and it doesn't already start with `docs/`, it's retried
 * under `docs/` — so the common case (files in the docs/ directory) works
 * without the redundant prefix.
 *
 * Access: ADMIN + SUPER_ADMIN only, same gate as the /admin/docs viewer —
 * these docs carry security findings and infra details and must never be
 * public. A logged-out hit redirects to /login with a callbackUrl so a
 * shared link lands on the doc right after sign-in. All path safety
 * (traversal guard, extension allowlist, directory blocklist, 1 MB cap)
 * comes from the same readDocFile() the viewer uses.
 *
 * Script safety: the viewer renders HTML docs in a sandboxed iframe so a
 * committed <script> can't run in the dashboard origin. Serving raw HTML
 * here would reopen that hole, so the response carries a CSP that permits
 * inline styles + images but NO script execution.
 */

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { readDocFile, type DocsFileContent } from "@/lib/docs-fs";
import { apiLogger } from "@/lib/logger";

interface RouteParams {
  params: Promise<{ path: string[] }>;
}

const HTML_SECURITY_HEADERS = {
  // Inline styles + self/data images keep the styled docs working; the
  // absent script-src (default-src 'none') blocks all script execution.
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; base-uri 'none'; form-action 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
  "Cache-Control": "private, no-store",
} as const;

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const [session, { path: segments }] = await Promise.all([auth(), params]);
    const relPath = (segments ?? []).join("/");

    if (!session?.user) {
      // Shared-link friendliness: sign in, land on the doc.
      const url = new URL(req.url);
      return NextResponse.redirect(
        new URL(`/login?callbackUrl=${encodeURIComponent(url.pathname)}`, url.origin),
      );
    }
    if (session.user.role !== "ADMIN" && session.user.role !== "SUPER_ADMIN") {
      apiLogger.warn({
        msg: "admin-docs:raw:forbidden",
        userId: session.user.id,
        role: session.user.role,
        path: relPath,
      });
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    if (!relPath) {
      return NextResponse.json({ error: "path is required" }, { status: 400 });
    }

    let file: DocsFileContent | null = null;
    try {
      file = await readDocFile(relPath);
      if (!file && !relPath.startsWith("docs/")) {
        file = await readDocFile(`docs/${relPath}`);
      }
    } catch (e) {
      // resolveSafe() throws on traversal attempts — log + 400.
      apiLogger.warn({
        msg: "admin-docs:raw:bad-path",
        userId: session.user.id,
        path: relPath,
        err: e instanceof Error ? e.message : String(e),
      });
      return NextResponse.json({ error: "Invalid path" }, { status: 400 });
    }

    if (!file) {
      // 404 on miss/blocked — same non-enumeration posture as the file API.
      apiLogger.warn({
        msg: "admin-docs:raw:not-found",
        userId: session.user.id,
        path: relPath,
      });
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    if (file.type === "html") {
      return new NextResponse(file.content, {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          ...HTML_SECURITY_HEADERS,
        },
      });
    }

    // Markdown → plain text (the /admin/docs viewer is the pretty renderer;
    // this URL is the raw/shareable form).
    return new NextResponse(file.content, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "X-Robots-Tag": "noindex, nofollow",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "admin-docs:raw:failed" });
    return NextResponse.json({ error: "Failed to load doc" }, { status: 500 });
  }
}
