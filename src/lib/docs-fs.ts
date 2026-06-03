/**
 * src/lib/docs-fs.ts
 *
 * Filesystem walker for the SUPER_ADMIN docs viewer. Walks the repo
 * from `process.cwd()` (the EA-SYS root on the EC2 box) and surfaces
 * every `.md` / `.html` outside the blocklist as a browsable tree.
 *
 * Source of truth = git. The docs auto-refresh on every deploy because
 * `scripts/deploy.sh` does a `git pull` before container swap. No DB
 * writes, no caching layer needed at this scale.
 *
 * Security posture:
 *   1. EXTENSION allowlist — only `.md` and `.html` files are surfaced.
 *      Source code, configs, secrets, lockfiles all filtered out.
 *   2. DIRECTORY blocklist — node_modules, .next, .git, build outputs,
 *      uploads, terraform state. Defense-in-depth even though the
 *      extension filter alone would skip most of these.
 *   3. PATH TRAVERSAL guard — every user-provided path goes through
 *      `resolveSafe()` which resolves against repo root + asserts the
 *      result stays inside. Rejects `../../etc/passwd` style escapes.
 *   4. SIZE cap — 1 MB per file. Anything bigger is a sign of something
 *      that shouldn't be in /docs (e.g. an accidentally committed PDF).
 *
 * Callers must do SUPER_ADMIN auth gating BEFORE invoking any of these
 * helpers — this module trusts that gating has already happened.
 */

import { readFile, readdir, stat } from "fs/promises";
import { join, relative, resolve, sep, extname } from "path";

const REPO_ROOT = process.cwd();

// Directories we never descend into. Match by name segment, not full
// path, so `node_modules` anywhere in the tree is excluded.
const DIR_BLOCKLIST = new Set<string>([
  "node_modules",
  ".next",
  ".git",
  ".turbo",
  "out",
  "dist",
  "build",
  "coverage",
  "playwright-report",
  "test-results",
  ".vercel",
  // public/uploads holds user-uploaded files — could include HTML the
  // attacker controls. Hard-block at the directory level.
  // (we walk public/ but skip uploads/ specifically below)
]);

// Max bytes per file. Anything bigger is almost certainly not docs.
// (Allowed extensions are checked via the `allowedExt()` helper below.)
const MAX_FILE_BYTES = 1_000_000;

// ── Types ────────────────────────────────────────────────────────────────

export type DocsTreeNode =
  | { type: "dir"; name: string; path: string; children: DocsTreeNode[] }
  | { type: "file"; name: string; path: string; size: number; ext: "md" | "html" };

export interface DocsFileContent {
  path: string;
  content: string;
  type: "markdown" | "html";
  size: number;
  mtime: string; // ISO
}

export interface DocsSearchHit {
  path: string;
  line: number;
  context: string; // ~80 chars around the match
}

// ── Path safety ──────────────────────────────────────────────────────────

/**
 * Resolve a user-supplied relative path against REPO_ROOT and guarantee
 * the result stays inside REPO_ROOT. Returns the absolute path on
 * success, throws on traversal attempts.
 *
 * We add `sep` to the prefix check so `/repo` doesn't match `/repo-evil`.
 */
function resolveSafe(userPath: string): string {
  // Normalise & strip leading slashes/dots; reject empty or null.
  const cleaned = (userPath || "").replace(/^[/\\]+/, "");
  if (!cleaned || cleaned.includes("\0")) {
    throw new Error("invalid path");
  }
  const abs = resolve(REPO_ROOT, cleaned);
  if (abs !== REPO_ROOT && !abs.startsWith(REPO_ROOT + sep)) {
    throw new Error("path escapes repository root");
  }
  return abs;
}

/** Is this directory name in the blocklist? */
function isBlockedDir(name: string): boolean {
  return DIR_BLOCKLIST.has(name);
}

/** Is this path under public/uploads/ specifically? */
function isUploadsPath(rel: string): boolean {
  return rel === "public/uploads"
    || rel.startsWith("public/uploads/")
    || rel.startsWith("public\\uploads\\");
}

/** Allowed extension check — returns the normalised ext or null. */
function allowedExt(name: string): "md" | "html" | null {
  const e = extname(name).toLowerCase();
  if (e === ".md") return "md";
  if (e === ".html" || e === ".htm") return "html";
  return null;
}

// ── Walker ───────────────────────────────────────────────────────────────

/**
 * Walk REPO_ROOT recursively and return a tree of allowed docs. Empty
 * directories (no docs anywhere under them) are pruned so the UI tree
 * doesn't drown in noise.
 */
export async function buildDocsTree(): Promise<DocsTreeNode[]> {
  return walkDir(REPO_ROOT, "");
}

async function walkDir(absDir: string, relDir: string): Promise<DocsTreeNode[]> {
  let entries;
  try {
    entries = await readdir(absDir, { withFileTypes: true });
  } catch {
    return [];
  }

  // Sort: dirs first, then alphabetical case-insensitive.
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name, "en", { sensitivity: "base" });
  });

  const nodes: DocsTreeNode[] = [];
  for (const entry of entries) {
    // Skip dotfiles (hidden) unless they're a known good (none today).
    if (entry.name.startsWith(".")) continue;

    const childRel = relDir ? join(relDir, entry.name) : entry.name;
    const childAbs = join(absDir, entry.name);

    if (entry.isDirectory()) {
      if (isBlockedDir(entry.name)) continue;
      if (isUploadsPath(childRel)) continue;
      const children = await walkDir(childAbs, childRel);
      if (children.length > 0) {
        nodes.push({
          type: "dir",
          name: entry.name,
          path: childRel,
          children,
        });
      }
      continue;
    }

    if (entry.isFile()) {
      const ext = allowedExt(entry.name);
      if (!ext) continue;
      let size = 0;
      try {
        const s = await stat(childAbs);
        size = s.size;
        if (size > MAX_FILE_BYTES) continue;
      } catch {
        continue;
      }
      nodes.push({
        type: "file",
        name: entry.name,
        path: childRel,
        size,
        ext,
      });
    }
  }
  return nodes;
}

// ── File read ────────────────────────────────────────────────────────────

/**
 * Read one file from disk. Validates path, extension, and size before
 * touching the filesystem. Returns null when the file doesn't exist —
 * caller turns that into a 404 (don't leak the reason).
 */
export async function readDocFile(userPath: string): Promise<DocsFileContent | null> {
  const abs = resolveSafe(userPath);

  const ext = allowedExt(abs);
  if (!ext) return null;

  // Re-check directory blocklist on the resolved path — the relative
  // user input may have nicely-named segments that resolve into a
  // blocked dir via symlinks. Walk segments of the relative portion.
  const rel = relative(REPO_ROOT, abs);
  for (const segment of rel.split(sep)) {
    if (isBlockedDir(segment)) return null;
  }
  if (isUploadsPath(rel)) return null;

  let s;
  try {
    s = await stat(abs);
  } catch {
    return null;
  }
  if (!s.isFile()) return null;
  if (s.size > MAX_FILE_BYTES) return null;

  const content = await readFile(abs, "utf8");

  return {
    path: rel,
    content,
    type: ext === "md" ? "markdown" : "html",
    size: s.size,
    mtime: s.mtime.toISOString(),
  };
}

// ── Search ───────────────────────────────────────────────────────────────

/**
 * Simple substring search across every allowed file. Case-insensitive,
 * literal (not regex — protects against ReDoS from operator-typed
 * patterns). Caps results so a 1-char query can't return 50,000 hits.
 *
 * Returns hits with line number + ~80-char context so the UI can show
 * a useful snippet without re-reading every file client-side.
 */
export async function searchDocs(
  query: string,
  maxHits = 100,
): Promise<DocsSearchHit[]> {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];

  const hits: DocsSearchHit[] = [];
  const tree = await buildDocsTree();
  await searchTree(tree, q, hits, maxHits);
  return hits;
}

async function searchTree(
  nodes: DocsTreeNode[],
  q: string,
  hits: DocsSearchHit[],
  maxHits: number,
): Promise<void> {
  for (const node of nodes) {
    if (hits.length >= maxHits) return;
    if (node.type === "dir") {
      await searchTree(node.children, q, hits, maxHits);
      continue;
    }
    // File — read + scan
    let content: string;
    try {
      content = await readFile(join(REPO_ROOT, node.path), "utf8");
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const idx = line.toLowerCase().indexOf(q);
      if (idx === -1) continue;
      // Build ~80-char context window centered on the match.
      const ctxStart = Math.max(0, idx - 30);
      const ctxEnd = Math.min(line.length, idx + q.length + 50);
      hits.push({
        path: node.path,
        line: i + 1,
        context: line.slice(ctxStart, ctxEnd).trim(),
      });
      if (hits.length >= maxHits) return;
    }
  }
}
