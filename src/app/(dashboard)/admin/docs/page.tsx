"use client";

/**
 * /admin/docs — ADMIN + SUPER_ADMIN docs viewer.
 *
 * Browseable repository of every .md / .html in the repo (outside the
 * blocklist). Split layout:
 *   - LEFT: collapsible tree + search box
 *   - RIGHT: rendered content (ReactMarkdown for .md, sandboxed iframe
 *            for .html so existing styled docs keep their look)
 *
 * Source of truth = git repo on disk. Every deploy's `git pull` updates
 * what this page shows — no DB, no Sanity, no editing UI by design
 * (decided in the planning round: edits go through PR like normal code).
 *
 * Auth posture: page itself is gated by the dashboard layout's role
 * checks; each API route also re-checks role server-side. The UI
 * gracefully shows a "Forbidden" panel if a role below ADMIN somehow
 * lands here (e.g., via shared URL).
 */

import { useEffect, useMemo, useState, useCallback } from "react";
import { useSession } from "next-auth/react";
import { useQuery } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  FileText,
  FileCode2,
  Folder,
  FolderOpen,
  Search,
  Lock,
  Loader2,
  AlertTriangle,
  ExternalLink,
  Copy,
  Check,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

// ── Types — mirror src/lib/docs-fs.ts ────────────────────────────────────

type TreeNode =
  | { type: "dir"; name: string; path: string; children: TreeNode[] }
  | { type: "file"; name: string; path: string; size: number; ext: "md" | "html" };

interface FileContent {
  path: string;
  content: string;
  type: "markdown" | "html";
  size: number;
  mtime: string;
}

interface SearchHit {
  path: string;
  line: number;
  context: string;
}

// ── Tree component ──────────────────────────────────────────────────────

interface TreeProps {
  nodes: TreeNode[];
  activePath: string | null;
  onSelect: (path: string) => void;
  depth?: number;
  defaultExpanded?: boolean;
}

function Tree({ nodes, activePath, onSelect, depth = 0, defaultExpanded = false }: TreeProps) {
  return (
    <ul className="space-y-0.5">
      {nodes.map((node) => (
        <TreeItem
          key={node.path}
          node={node}
          activePath={activePath}
          onSelect={onSelect}
          depth={depth}
          defaultExpanded={defaultExpanded}
        />
      ))}
    </ul>
  );
}

interface TreeItemProps {
  node: TreeNode;
  activePath: string | null;
  onSelect: (path: string) => void;
  depth: number;
  defaultExpanded: boolean;
}

function TreeItem({ node, activePath, onSelect, depth, defaultExpanded }: TreeItemProps) {
  // Auto-expand directories at depth 0 OR if any active descendant lives
  // under them — so opening a deep-linked file lights up the right path.
  const containsActive = useMemo(() => {
    if (!activePath) return false;
    if (node.type === "file") return node.path === activePath;
    return activePath.startsWith(node.path + "/");
  }, [activePath, node]);

  // "Store info from previous render" pattern — when containsActive
  // flips true (e.g., a deep-linked file lit up an ancestor), expand on
  // the very same render rather than waiting for an effect. React 19's
  // `set-state-in-effect` rule rejects the useEffect+setState shape.
  const [expanded, setExpanded] = useState(defaultExpanded || depth === 0 || containsActive);
  const [prevContainsActive, setPrevContainsActive] = useState(containsActive);
  if (containsActive !== prevContainsActive) {
    setPrevContainsActive(containsActive);
    if (containsActive) setExpanded(true);
  }

  if (node.type === "file") {
    const Icon = node.ext === "html" ? FileCode2 : FileText;
    const isActive = activePath === node.path;
    return (
      <li>
        <button
          type="button"
          onClick={() => onSelect(node.path)}
          className={`flex items-center gap-1.5 w-full rounded px-1.5 py-1 text-left text-sm hover:bg-muted transition-colors ${
            isActive ? "bg-primary/10 text-primary font-medium" : "text-foreground/80"
          }`}
          style={{ paddingLeft: `${depth * 12 + 6}px` }}
          title={node.path}
        >
          <Icon className="h-3.5 w-3.5 shrink-0 opacity-70" />
          <span className="truncate">{node.name}</span>
        </button>
      </li>
    );
  }

  return (
    <li>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1.5 w-full rounded px-1.5 py-1 text-left text-sm hover:bg-muted transition-colors text-foreground/70"
        style={{ paddingLeft: `${depth * 12 + 6}px` }}
      >
        {expanded ? (
          <FolderOpen className="h-3.5 w-3.5 shrink-0 text-amber-600" />
        ) : (
          <Folder className="h-3.5 w-3.5 shrink-0 text-amber-600/80" />
        )}
        <span className="truncate font-medium">{node.name}</span>
      </button>
      {expanded && (
        <Tree
          nodes={node.children}
          activePath={activePath}
          onSelect={onSelect}
          depth={depth + 1}
          defaultExpanded={false}
        />
      )}
    </li>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────

export default function AdminDocsPage() {
  const { data: session, status } = useSession();
  const [activePath, setActivePath] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");

  // Debounce search input — typing "registr" shouldn't fire 7 requests.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(searchQuery.trim()), 300);
    return () => clearTimeout(t);
  }, [searchQuery]);

  // Default selection on first load — try infra/dr/README.md if present
  // (most likely useful entry point for ops work), else first file we
  // can find in the tree.
  // Role gate: ADMIN + SUPER_ADMIN can browse docs. Computed once so
  // all 4 query enable-guards + the page-level Forbidden panel below
  // stay in sync — adding a third allowed role (or removing one)
  // is a one-line change here, not a 5-place search.
  const userRole = session?.user?.role;
  const canViewDocs = userRole === "ADMIN" || userRole === "SUPER_ADMIN";

  const treeQuery = useQuery({
    queryKey: ["admin-docs-tree"],
    queryFn: async () => {
      const res = await fetch("/api/admin/docs/tree");
      if (!res.ok) throw new Error("Failed to load docs tree");
      return (await res.json()) as { tree: TreeNode[] };
    },
    enabled: status === "authenticated" && canViewDocs,
  });

  // Same "store info from previous render" pattern — pick a sensible
  // default file on first tree load without triggering React 19's
  // set-state-in-effect rule.
  const treeData = treeQuery.data?.tree;
  const [seenTree, setSeenTree] = useState<TreeNode[] | undefined>(undefined);
  if (treeData && treeData !== seenTree) {
    setSeenTree(treeData);
    if (!activePath) {
      const found = findDefaultDoc(treeData);
      if (found) setActivePath(found);
    }
  }

  const fileQuery = useQuery({
    queryKey: ["admin-docs-file", activePath],
    queryFn: async () => {
      const res = await fetch(`/api/admin/docs/file?path=${encodeURIComponent(activePath!)}`);
      if (!res.ok) throw new Error("Failed to load file");
      return (await res.json()) as { file: FileContent };
    },
    enabled: !!activePath && canViewDocs,
  });

  const searchResultsQuery = useQuery({
    queryKey: ["admin-docs-search", debouncedQuery],
    queryFn: async () => {
      const res = await fetch(`/api/admin/docs/search?q=${encodeURIComponent(debouncedQuery)}`);
      if (!res.ok) throw new Error("Search failed");
      return (await res.json()) as { hits: SearchHit[] };
    },
    enabled: debouncedQuery.length >= 2 && canViewDocs,
  });

  const copyPath = useCallback((p: string) => {
    navigator.clipboard.writeText(p).then(
      () => toast.success("Path copied"),
      () => toast.error("Couldn't copy — clipboard blocked?"),
    );
  }, []);

  // ── Auth gate ──────────────────────────────────────────────────────────
  if (status === "loading") {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!session?.user || !canViewDocs) {
    return (
      <div className="max-w-md mx-auto mt-20 rounded-lg border border-amber-300 bg-amber-50 p-6 text-center">
        <Lock className="h-8 w-8 mx-auto text-amber-700 mb-3" />
        <h2 className="font-semibold text-amber-900">Admin only</h2>
        <p className="text-sm text-amber-800 mt-2">
          The repository docs viewer is restricted to admins.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-[calc(100vh-7rem)] gap-3">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Repository Docs</h1>
        <p className="text-sm text-muted-foreground">
          Every <code className="text-xs">.md</code> /{" "}
          <code className="text-xs">.html</code> in the repo. Source of truth is
          git — updates on every deploy. Admin access.
        </p>
      </div>

      <div className="grid grid-cols-[280px_1fr] gap-4 flex-1 min-h-0">
        {/* ── Left: nav + search ──────────────────────────────────────── */}
        <aside className="rounded-lg border bg-card overflow-hidden flex flex-col">
          <div className="p-3 border-b">
            <div className="relative">
              <Search className="h-4 w-4 absolute left-2.5 top-2.5 text-muted-foreground" />
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search across all docs…"
                className="pl-8 text-sm"
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-2 text-sm">
            {debouncedQuery.length >= 2 ? (
              <SearchResults
                query={debouncedQuery}
                isLoading={searchResultsQuery.isLoading}
                hits={searchResultsQuery.data?.hits ?? []}
                onSelect={(path) => {
                  setActivePath(path);
                  // Don't clear the search — operator may want to scan
                  // more hits after viewing the first one.
                }}
              />
            ) : (
              <>
                {treeQuery.isLoading ? (
                  <div className="flex items-center gap-2 px-2 py-3 text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    <span>Loading tree…</span>
                  </div>
                ) : treeQuery.isError ? (
                  <div className="rounded border border-red-300 bg-red-50 p-3 text-red-800">
                    <AlertTriangle className="h-4 w-4 inline mr-1" />
                    Failed to load docs tree.
                  </div>
                ) : (
                  <Tree
                    nodes={treeQuery.data?.tree ?? []}
                    activePath={activePath}
                    onSelect={setActivePath}
                  />
                )}
              </>
            )}
          </div>
        </aside>

        {/* ── Right: content ──────────────────────────────────────────── */}
        <main className="rounded-lg border bg-card overflow-hidden flex flex-col min-w-0">
          {!activePath ? (
            <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
              Select a file on the left to view.
            </div>
          ) : fileQuery.isLoading ? (
            <div className="flex-1 flex items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : fileQuery.isError ? (
            <div className="flex-1 flex items-center justify-center">
              <div className="rounded border border-red-300 bg-red-50 p-4 text-red-800 max-w-md text-center">
                <AlertTriangle className="h-5 w-5 inline mr-1" />
                Failed to load <code className="text-xs">{activePath}</code>.
              </div>
            </div>
          ) : fileQuery.data ? (
            <FileViewer file={fileQuery.data.file} onCopyPath={copyPath} />
          ) : null}
        </main>
      </div>
    </div>
  );
}

// ── Sub-components ───────────────────────────────────────────────────────

function SearchResults({
  query,
  isLoading,
  hits,
  onSelect,
}: {
  query: string;
  isLoading: boolean;
  hits: SearchHit[];
  onSelect: (path: string) => void;
}) {
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 px-2 py-3 text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        <span>Searching…</span>
      </div>
    );
  }
  if (hits.length === 0) {
    return (
      <div className="px-2 py-3 text-muted-foreground text-xs">
        No matches for &ldquo;{query}&rdquo;.
      </div>
    );
  }

  // Group by file path so the same file's hits sit together.
  const grouped = new Map<string, SearchHit[]>();
  for (const h of hits) {
    const arr = grouped.get(h.path) ?? [];
    arr.push(h);
    grouped.set(h.path, arr);
  }

  return (
    <div className="space-y-3">
      <div className="px-2 text-xs text-muted-foreground">
        {hits.length} match{hits.length === 1 ? "" : "es"}
        {hits.length >= 100 ? " (capped)" : ""} in {grouped.size} file
        {grouped.size === 1 ? "" : "s"}
      </div>
      {Array.from(grouped.entries()).map(([path, hitsInFile]) => (
        <div key={path} className="space-y-1">
          <button
            type="button"
            onClick={() => onSelect(path)}
            className="w-full text-left text-xs font-medium text-primary hover:underline px-2 truncate"
            title={path}
          >
            {path}
          </button>
          <ul className="space-y-0.5 px-2">
            {hitsInFile.slice(0, 5).map((h, i) => (
              <li key={i} className="text-xs text-muted-foreground">
                <span className="opacity-70 mr-1.5">L{h.line}:</span>
                {h.context}
              </li>
            ))}
            {hitsInFile.length > 5 && (
              <li className="text-xs text-muted-foreground italic opacity-70">
                + {hitsInFile.length - 5} more
              </li>
            )}
          </ul>
        </div>
      ))}
    </div>
  );
}

function FileViewer({
  file,
  onCopyPath,
}: {
  file: FileContent;
  onCopyPath: (p: string) => void;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    onCopyPath(file.path);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <>
      <div className="border-b bg-muted/30 px-4 py-2 flex items-center gap-2 text-sm">
        <code className="flex-1 truncate text-xs font-mono text-muted-foreground">
          {file.path}
        </code>
        <span className="text-xs text-muted-foreground shrink-0">
          {(file.size / 1024).toFixed(1)} KB · modified{" "}
          {new Date(file.mtime).toLocaleDateString()}
        </span>
        <Button
          size="sm"
          variant="ghost"
          onClick={handleCopy}
          title="Copy file path"
          className="h-7 px-2"
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 text-emerald-600" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0">
        {file.type === "markdown" ? (
          <div className="prose prose-sm dark:prose-invert max-w-none p-6 prose-headings:scroll-mt-4 prose-pre:text-xs prose-code:text-xs prose-code:bg-transparent prose-code:text-emerald-700 dark:prose-code:text-emerald-400 prose-code:font-normal prose-code:before:content-none prose-code:after:content-none prose-table:text-xs">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {file.content}
            </ReactMarkdown>
          </div>
        ) : (
          // Sandboxed iframe for HTML — preserves the styled docs in
          // docs/*.html (EC2_HARDENING, CERTIFICATES, user-guide, etc.)
          // without their CSS colliding with the dashboard theme.
          //
          // sandbox: omit allow-scripts so any inline <script> in the
          // file (or future supply-chain injection) can't run inside
          // the dashboard origin. allow-same-origin lets internal
          // anchor links work.
          //
          // Better discoverability: a "Open in new tab" affordance for
          // anyone who wants the full-screen styled view.
          <div className="flex-1 flex flex-col h-full">
            <div className="bg-muted/20 px-4 py-1.5 text-xs text-muted-foreground border-b flex items-center justify-between">
              <span>HTML rendered in sandboxed frame</span>
              <a
                // Raw shareable URL — served admin-gated with a no-script CSP
                // by src/app/admin/docs/[...path]/route.ts. (The old `/${path}`
                // href 404'd — only public/ files resolve at the root.)
                href={`/admin/docs/${file.path}`}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 text-primary hover:underline"
              >
                Open in new tab <ExternalLink className="h-3 w-3" />
              </a>
            </div>
            <iframe
              key={file.path}
              srcDoc={file.content}
              sandbox="allow-same-origin"
              className="flex-1 w-full border-0"
              title={file.path}
            />
          </div>
        )}
      </div>
    </>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────

function findDefaultDoc(nodes: TreeNode[]): string | null {
  // Prefer infra/dr/README.md as the most useful "where do I start" page.
  const preferred = ["infra/dr/README.md", "docs/HANDOVER.md", "CLAUDE.md", "README.md"];
  const allFiles: TreeNode[] = [];
  collectFiles(nodes, allFiles);
  for (const p of preferred) {
    if (allFiles.some((f) => f.path === p)) return p;
  }
  return allFiles[0]?.path ?? null;
}

function collectFiles(nodes: TreeNode[], out: TreeNode[]): void {
  for (const node of nodes) {
    if (node.type === "file") out.push(node);
    else collectFiles(node.children, out);
  }
}
