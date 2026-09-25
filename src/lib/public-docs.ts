/**
 * Public doc links (September 25, 2026). Owner: "give an option against an
 * html file to be shareable to public". The platform operator switches a repo
 * HTML doc to public in the docs viewer; its shared link
 * /admin/docs/<path> then opens without sign-in. Every other doc stays behind
 * the existing gate (operator, plus org ADMINs on master).
 *
 * Deliberately narrow:
 * - HTML only. A .md file is served as raw text and stays private.
 * - Master only: honoured only where ADMIN_DOC_LINKS_ENABLED=true, the same
 *   flag that already means "this deployment shares docs" and that the
 *   platform instance never sets.
 * - Keyed by the path the docs reader resolves (e.g. "docs/X.html"), so the
 *   short URL /admin/docs/X.html and the long one match the same row.
 * - Opt-in per doc; nothing is public by default, and deleting the row makes
 *   the doc private again on the next request (responses are no-store).
 */
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { readDocFile } from "@/lib/docs-fs";
import { isAdminDocLinksEnabled } from "@/lib/module-flags";

/** Whether this deployment honours public doc links at all. */
export function publicDocLinksEnabled(): boolean {
  return isAdminDocLinksEnabled();
}

/** True when the resolved doc path has been made public (and the deployment honours it). */
export async function isDocPublic(resolvedPath: string): Promise<boolean> {
  if (!publicDocLinksEnabled()) return false;
  const row = await db.publicDoc.findUnique({ where: { path: resolvedPath }, select: { path: true } });
  return row !== null;
}

/** Every public doc path, for the viewer's badges. Empty where the deployment does not honour them. */
export async function listPublicDocPaths(): Promise<string[]> {
  if (!publicDocLinksEnabled()) return [];
  const rows = await db.publicDoc.findMany({ select: { path: true }, orderBy: { path: "asc" } });
  return rows.map((r) => r.path);
}

export type SetDocPublicResult =
  | { ok: true; path: string; public: boolean }
  | { ok: false; code: "DISABLED" | "NOT_FOUND" | "NOT_HTML" | "INVALID_PATH"; message: string };

/**
 * Make a doc public or private again. The caller has already checked that the
 * user is the platform operator. The path is resolved through the same reader
 * the shared link uses, so only a file that exists, sits outside the blocked
 * directories and is HTML can be made public.
 */
export async function setDocPublic(args: { path: string; makePublic: boolean; userId: string }): Promise<SetDocPublicResult> {
  if (!publicDocLinksEnabled()) {
    apiLogger.warn({ msg: "public-docs:disabled", userId: args.userId, path: args.path });
    return { ok: false, code: "DISABLED", message: "Public doc links are not enabled on this deployment." };
  }
  let file;
  try {
    // Same resolution as the shared link: as given, then under docs/.
    file = await readDocFile(args.path);
    if (!file && !args.path.startsWith("docs/")) file = await readDocFile(`docs/${args.path}`);
  } catch (err) {
    apiLogger.warn({ msg: "public-docs:invalid-path", userId: args.userId, path: args.path.slice(0, 200), err: String(err) });
    return { ok: false, code: "INVALID_PATH", message: "Invalid path." };
  }
  if (!file) {
    apiLogger.warn({ msg: "public-docs:not-found", userId: args.userId, path: args.path });
    return { ok: false, code: "NOT_FOUND", message: "Doc not found." };
  }
  if (file.type !== "html") {
    apiLogger.warn({ msg: "public-docs:not-html", userId: args.userId, path: file.path });
    return { ok: false, code: "NOT_HTML", message: "Only HTML docs can be made public." };
  }

  if (args.makePublic) {
    await db.publicDoc.upsert({
      where: { path: file.path },
      update: {},
      create: { path: file.path, sharedByUserId: args.userId },
    });
  } else {
    await db.publicDoc.deleteMany({ where: { path: file.path } });
  }
  // A security-relevant change: who opened or closed which doc to the public.
  await db.auditLog
    .create({
      data: {
        userId: args.userId,
        action: args.makePublic ? "SHARE" : "UNSHARE",
        entityType: "PublicDoc",
        entityId: file.path,
        changes: { path: file.path, public: args.makePublic },
      },
    })
    .catch((err) => apiLogger.error({ err, msg: "public-docs:audit-log-failed", path: file.path }));
  apiLogger.info({ msg: args.makePublic ? "public-docs:shared" : "public-docs:unshared", userId: args.userId, path: file.path });
  return { ok: true, path: file.path, public: args.makePublic };
}
