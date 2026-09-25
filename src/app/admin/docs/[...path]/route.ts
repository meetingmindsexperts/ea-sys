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
 * Access: the PLATFORM OPERATOR, plus org ADMINs where the deployment sets
 * ADMIN_DOC_LINKS_ENABLED=true (master only, Sep 24 2026; see
 * `isAdminDocLinksEnabled`). These docs carry security findings and infra
 * details and must never be public. A logged-out hit redirects to /login with
 * a callbackUrl so a shared link lands on the doc right after sign-in. All path safety
 * (traversal guard, extension allowlist, directory blocklist, 1 MB cap)
 * comes from the same readDocFile() the viewer uses.
 *
 * Public docs (Sep 25, 2026): an HTML doc the operator switched to public in
 * the viewer (src/lib/public-docs.ts) is served to ANYONE, signed in or not,
 * where ADMIN_DOC_LINKS_ENABLED=true. A caller without access who asks for
 * any other path gets exactly what they got before (login redirect, or 403),
 * so the public lane does not reveal which private docs exist.
 *
 * Script safety: the viewer renders HTML docs in a sandboxed iframe so a
 * committed <script> can't run in the dashboard origin. Serving raw HTML
 * here would reopen that hole, so the response carries a CSP that permits
 * inline styles + images but NO script execution.
 */

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { canActAsPlatformOperator } from "@/lib/platform-operator";
import { isAdminDocLinksEnabled } from "@/lib/module-flags";
import { readDocFile, type DocsFileContent } from "@/lib/docs-fs";
import { apiLogger } from "@/lib/logger";
import { isDocPublic, publicDocLinksEnabled } from "@/lib/public-docs";

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

/**
 * Where to send a signed-out visitor. Behind nginx, `req.url` carries the
 * container's own origin (it produced https://0.0.0.0:3000/login in prod), so
 * the public app URL wins when it is set.
 */
function loginRedirect(req: Request): NextResponse {
  const { pathname, origin } = new URL(req.url);
  const base = process.env.NEXT_PUBLIC_APP_URL || origin;
  return NextResponse.redirect(
    new URL(`/login?callbackUrl=${encodeURIComponent(pathname)}`, base),
  );
}

/**
 * The operator always; an org ADMIN only where the deployment opted in.
 * Returns which of the two let the caller through, for the access log.
 */
function docAccess(user: { role?: string | null; organizationId?: string | null }): "operator" | "admin" | null {
  if (canActAsPlatformOperator(user)) return "operator";
  if (user.role === "ADMIN" && isAdminDocLinksEnabled()) return "admin";
  return null;
}

/**
 * The file for a URL path: as given, then under docs/. Throws on traversal
 * (resolveSafe), which callers treat as a bad path.
 */
async function resolveDoc(relPath: string): Promise<DocsFileContent | null> {
  const file = await readDocFile(relPath);
  if (file || relPath.startsWith("docs/")) return file;
  return readDocFile(`docs/${relPath}`);
}

/**
 * The public lane: the doc when it is HTML and switched to public, else null
 * (and the caller answers exactly as it would have without this lane).
 */
async function servePublicDoc(relPath: string, userId: string | undefined): Promise<NextResponse | null> {
  if (!relPath || !publicDocLinksEnabled()) return null;
  let file: DocsFileContent | null;
  try {
    file = await resolveDoc(relPath);
  } catch {
    return null;
  }
  if (!file || file.type !== "html" || !(await isDocPublic(file.path))) return null;
  apiLogger.info({ msg: "admin-docs:raw:served-public", path: file.path, signedIn: Boolean(userId) });
  return new NextResponse(file.content, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", ...HTML_SECURITY_HEADERS },
  });
}

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const [session, { path: segments }] = await Promise.all([auth(), params]);
    const relPath = (segments ?? []).join("/");

    const access = session?.user ? docAccess(session.user) : null;
    if (!access) {
      // A doc the operator made public opens for anyone (Sep 25, 2026).
      const shared = await servePublicDoc(relPath, session?.user?.id);
      if (shared) return shared;
    }

    if (!session?.user) {
      // Shared-link friendliness: sign in, land on the doc.
      return loginRedirect(req);
    }
    // Narrowed from ADMIN to PLATFORM OPERATOR, Aug 21 2026 — see the comment
    // on the /api/admin/docs/* routes. This one matters slightly more than
    // those: it serves the raw file at a shareable URL, so a link pasted into
    // a chat is only as safe as this check.
    // Widened again for org ADMINs on master only, Sep 24 2026 (docAccess).
    if (!access) {
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
      file = await resolveDoc(relPath);
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

    // An ADMIN read is the widened lane, so it leaves a trace of who opened what.
    if (access === "admin") {
      apiLogger.info({
        msg: "admin-docs:raw:served-to-admin",
        userId: session.user.id,
        path: file.path,
      });
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
