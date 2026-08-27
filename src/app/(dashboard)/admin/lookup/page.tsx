"use client";

/**
 * /admin/lookup — paste an id from a log line, get the name back.
 *
 * The companion to /logs. Log lines name rows by id, so "which event is
 * cmt8fkgbl…?" used to mean opening a psql session. Paste the id — or the
 * whole log line, which is one copy instead of picking the id out by hand —
 * and every id in it resolves at once.
 *
 * The gate here is UX; /api/admin/lookup re-checks the operator boundary
 * server-side and is the authority.
 */

import { useState, useCallback, useEffect, Suspense } from "react";
import { useSession } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Lock,
  ScanSearch,
  Loader2,
  Copy,
  ExternalLink,
  CircleSlash,
} from "lucide-react";
import { toast } from "sonner";

interface LookupHit {
  kind: string;
  id: string;
  title: string;
  subtitle?: string;
  eventId?: string | null;
  organizationId?: string | null;
  href?: string | null;
  eventName?: string | null;
  organizationName?: string | null;
}

interface LookupResult {
  id: string;
  hits: LookupHit[];
}

interface LookupResponse {
  ids: string[];
  results: LookupResult[];
  truncated: boolean;
}

const PLACEHOLDER = `Paste an id, or the whole log line:

{"level":50,"msg":"registration-update:unique-constraint","eventId":"cmt8fkgbl0003ry01jjysncwe","registrationId":"cmxk2p9qq0001la04h1v8bqzt"}`;

function LookupPageInner() {
  const { data: session, status } = useSession();
  const searchParams = useSearchParams();
  const [input, setInput] = useState("");
  const [data, setData] = useState<LookupResponse | null>(null);
  const [loading, setLoading] = useState(false);

  const isSuperAdmin = session?.user?.role === "SUPER_ADMIN";

  const runLookup = useCallback(async (text: string) => {
    const q = text.trim();
    if (!q) {
      setData(null);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/lookup?q=${encodeURIComponent(q)}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || `Lookup failed (${res.status})`);
      }
      setData((await res.json()) as LookupResponse);
    } catch (err) {
      console.error("admin-lookup failed", err);
      toast.error(err instanceof Error ? err.message : "Lookup failed");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  // Deep link support: /admin/lookup?q=<id> pre-fills and runs, so /logs (and
  // a bookmark, and a pasted URL) can hand an id straight over.
  const initialQ = searchParams.get("q") ?? "";
  const [primedFor, setPrimedFor] = useState<string | null>(null);
  if (initialQ && primedFor !== initialQ) {
    setPrimedFor(initialQ);
    setInput(initialQ);
  }
  useEffect(() => {
    if (initialQ) void runLookup(initialQ);
  }, [initialQ, runLookup]);

  if (status === "loading") {
    return (
      <div className="flex items-center justify-center mt-20 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin mr-2" />
        Loading…
      </div>
    );
  }

  if (!session?.user || !isSuperAdmin) {
    return (
      <div className="max-w-md mx-auto mt-20 rounded-lg border border-amber-300 bg-amber-50 p-6 text-center">
        <Lock className="h-8 w-8 mx-auto text-amber-700 mb-3" />
        <h2 className="font-semibold text-amber-900">Super admin only</h2>
        <p className="text-sm text-amber-800 mt-2">
          The id lookup reads across every tenant, so it is restricted to super
          admins.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <ScanSearch className="h-6 w-6 text-primary" />
          ID Lookup
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Paste an id from a log line and get the name back. A whole log line
          works too — every id in it is resolved at once.
        </p>
      </div>

      <div className="space-y-2">
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void runLookup(input);
            }
          }}
          placeholder={PLACEHOLDER}
          rows={5}
          className="font-mono text-xs"
        />
        <div className="flex items-center gap-2">
          <Button onClick={() => void runLookup(input)} disabled={loading}>
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ScanSearch className="h-4 w-4" />
            )}
            Look up
          </Button>
          {(input || data) && (
            <Button
              variant="ghost"
              onClick={() => {
                setInput("");
                setData(null);
              }}
            >
              Clear
            </Button>
          )}
          <span className="text-xs text-muted-foreground ml-auto">
            ⌘/Ctrl + Enter
          </span>
        </div>
      </div>

      {data && data.ids.length === 0 && (
        <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          No ids found in that text. Paste a full id (they look like{" "}
          <code className="font-mono">cmt8fkgbl0003ry01jjysncwe</code>) or a log
          line containing one.
        </div>
      )}

      {data?.truncated && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          Only the first {data.ids.length} ids from that paste were looked up.
        </div>
      )}

      {data?.results.map((result) => (
        <div key={result.id} className="rounded-lg border overflow-hidden">
          <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-2">
            <code className="font-mono text-xs break-all">{result.id}</code>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 ml-auto shrink-0"
              onClick={() => {
                void navigator.clipboard.writeText(result.id);
                toast.success("Id copied");
              }}
            >
              <Copy className="h-3 w-3" />
            </Button>
          </div>

          {result.hits.length === 0 ? (
            <div className="flex items-center gap-2 px-3 py-4 text-sm text-muted-foreground">
              <CircleSlash className="h-4 w-4 shrink-0" />
              No row anywhere with this id. It may have been deleted, or it may
              belong to a table the lookup does not cover yet.
            </div>
          ) : (
            <div className="divide-y">
              {result.hits.map((hit) => (
                <div
                  key={`${hit.kind}-${hit.id}`}
                  className="flex items-start gap-3 px-3 py-3"
                >
                  <Badge variant="secondary" className="shrink-0 mt-0.5">
                    {hit.kind}
                  </Badge>
                  <div className="min-w-0 flex-1">
                    <div className="font-medium break-words">{hit.title}</div>
                    {hit.subtitle && (
                      <div className="text-xs text-muted-foreground mt-0.5 break-words">
                        {hit.subtitle}
                      </div>
                    )}
                    {(hit.eventName || hit.organizationName) && (
                      <div className="text-xs text-muted-foreground mt-1">
                        {hit.eventName && (
                          <>
                            Event:{" "}
                            <span className="text-foreground">
                              {hit.eventName}
                            </span>
                          </>
                        )}
                        {hit.eventName && hit.organizationName && " · "}
                        {hit.organizationName && (
                          <>
                            Org:{" "}
                            <span className="text-foreground">
                              {hit.organizationName}
                            </span>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                  {hit.href && (
                    <Link
                      href={hit.href}
                      className="shrink-0 text-xs text-primary hover:underline inline-flex items-center gap-1 mt-1"
                    >
                      Open <ExternalLink className="h-3 w-3" />
                    </Link>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export default function LookupPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center mt-20 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin mr-2" />
          Loading…
        </div>
      }
    >
      <LookupPageInner />
    </Suspense>
  );
}
