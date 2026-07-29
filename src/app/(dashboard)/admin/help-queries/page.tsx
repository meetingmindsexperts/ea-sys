"use client";

/**
 * /admin/help-queries — SUPER_ADMIN view of what users are asking the Help
 * Assistant. Reads HelpChatQuery via /api/help-chat/queries (which re-checks
 * SUPER_ADMIN server-side — this page's gate is UX, the API is the authority).
 *
 * Questions can reference real attendee data, so this is deliberately the only
 * surface where the captured Q&A is visible, and only to SUPER_ADMIN.
 */

import { useState } from "react";
import { useSession } from "next-auth/react";
import { useQuery } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Lock,
  Search,
  MessageCircleQuestion,
  ChevronLeft,
  ChevronRight,
  Loader2,
} from "lucide-react";

interface HelpChatQueryRow {
  id: string;
  userId: string | null;
  userEmail: string | null;
  userName: string | null;
  role: string | null;
  organizationId: string | null;
  organizationName: string | null;
  question: string;
  answer: string;
  createdAt: string;
}

interface QueriesResponse {
  queries: HelpChatQueryRow[];
  total: number;
  page: number;
  limit: number;
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function HelpQueriesPage() {
  const { data: session, status } = useSession();
  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const isSuperAdmin = session?.user?.role === "SUPER_ADMIN";

  const { data, isLoading, isError, isFetching } = useQuery({
    queryKey: ["help-queries", query, page],
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(page), limit: "25" });
      if (query) params.set("q", query);
      const res = await fetch(`/api/help-chat/queries?${params.toString()}`);
      if (!res.ok) throw new Error("Failed to load help-assistant queries");
      return (await res.json()) as QueriesResponse;
    },
    enabled: status === "authenticated" && isSuperAdmin,
  });

  function runSearch() {
    setPage(1);
    setQuery(searchInput.trim());
  }

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
          Help-assistant queries can reference real attendee data and are
          restricted to super admins.
        </p>
      </div>
    );
  }

  const total = data?.total ?? 0;
  const limit = data?.limit ?? 25;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <div className="max-w-4xl mx-auto space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <MessageCircleQuestion className="h-6 w-6 text-primary" />
          Help Assistant Queries
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          What users are asking the in-app Help Assistant, with the answer they
          got. Super-admin only — questions may reference real attendee data.
        </p>
      </div>

      {/* Search */}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="h-4 w-4 absolute left-2.5 top-2.5 text-muted-foreground" />
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") runSearch();
            }}
            placeholder="Search questions and answers…"
            className="pl-8"
          />
        </div>
        <Button onClick={runSearch} variant="secondary">
          Search
        </Button>
        {query && (
          <Button
            variant="ghost"
            onClick={() => {
              setSearchInput("");
              setQuery("");
              setPage(1);
            }}
          >
            Clear
          </Button>
        )}
      </div>

      {/* Result count */}
      <div className="text-sm text-muted-foreground flex items-center gap-2">
        {isFetching && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        {total} {total === 1 ? "query" : "queries"}
        {query && <span>matching “{query}”</span>}
      </div>

      {/* List */}
      {isLoading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin mr-2" />
          Loading queries…
        </div>
      ) : isError ? (
        <div className="rounded-lg border border-red-300 bg-red-50 p-6 text-center text-sm text-red-800">
          Couldn’t load help-assistant queries. Please try again.
        </div>
      ) : (data?.queries.length ?? 0) === 0 ? (
        <div className="rounded-lg border bg-card p-10 text-center text-sm text-muted-foreground">
          {query
            ? "No queries match your search."
            : "No help-assistant queries captured yet."}
        </div>
      ) : (
        <ul className="space-y-3">
          {data!.queries.map((row) => {
            const isOpen = expanded[row.id];
            return (
              <li key={row.id} className="rounded-lg border bg-card p-4">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground mb-2">
                  <span className="font-medium text-foreground">
                    {row.userName || row.userEmail || "Unknown user"}
                  </span>
                  {row.role && (
                    <span className="rounded bg-muted px-1.5 py-0.5">
                      {row.role}
                    </span>
                  )}
                  {row.organizationName && <span>· {row.organizationName}</span>}
                  <span className="ml-auto">{formatWhen(row.createdAt)}</span>
                </div>

                <p className="text-sm font-medium whitespace-pre-wrap">
                  {row.question}
                </p>

                <div className="mt-2">
                  <button
                    onClick={() =>
                      setExpanded((prev) => ({ ...prev, [row.id]: !prev[row.id] }))
                    }
                    className="text-xs text-primary hover:underline"
                  >
                    {isOpen ? "Hide answer" : "Show answer"}
                  </button>
                  {isOpen && (
                    <p className="mt-2 text-sm text-muted-foreground whitespace-pre-wrap border-l-2 border-muted pl-3">
                      {row.answer || "(empty answer)"}
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* Pagination */}
      {total > limit && (
        <div className="flex items-center justify-between pt-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1 || isFetching}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            <ChevronLeft className="h-4 w-4 mr-1" /> Previous
          </Button>
          <span className="text-sm text-muted-foreground">
            Page {page} of {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages || isFetching}
            onClick={() => setPage((p) => p + 1)}
          >
            Next <ChevronRight className="h-4 w-4 ml-1" />
          </Button>
        </div>
      )}
    </div>
  );
}
