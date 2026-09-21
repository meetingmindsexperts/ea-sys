"use client";

/**
 * /admin/agent-messages, the SUPER_ADMIN view of the Event Agent's stored
 * conversations: what each person asked, what the agent replied, and every
 * tool call with its exact input. Reads /api/agent/messages, which re-checks
 * the operator boundary server-side; this page's gate is UX, the API is the
 * authority. Attendee data can appear in every field, which is why the page
 * exists nowhere else and the rows leave after 180 days.
 */

import { useState } from "react";
import { useSession } from "next-auth/react";
import { useQuery } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Lock, Search, MessagesSquare, ChevronLeft, ChevronRight, Loader2 } from "lucide-react";

interface AgentStepRow {
  seq: number;
  tool: string;
  outcome: "RAN" | "ERROR" | "REFUSED" | "APPROVAL_REQUESTED" | "UNKNOWN_TOOL";
  code: string | null;
  write: boolean;
  approved: boolean;
  durationMs: number;
  input: unknown;
}

interface AgentMessageRow {
  id: string;
  organizationId: string;
  userId: string;
  role: string;
  eventId: string | null;
  route: string;
  message: string | null;
  reply: string | null;
  historyPairs: number;
  approvedTool: string | null;
  model: string | null;
  outcome: "RUNNING" | "COMPLETED" | "ERROR" | "TURN_LIMIT";
  errorClass: string | null;
  turns: number;
  toolCalls: number;
  writes: number;
  refusals: number;
  approvalsRequested: number;
  approvalsRun: number;
  toolErrors: number;
  inputTokens: number;
  outputTokens: number;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  steps: AgentStepRow[];
  user: { name: string | null; email: string | null } | null;
  event: { name: string } | null;
  organization: { name: string } | null;
}

interface MessagesResponse {
  runs: AgentMessageRow[];
  total: number;
  page: number;
  limit: number;
}

const OUTCOME_LABEL: Record<AgentMessageRow["outcome"], string> = {
  RUNNING: "Running",
  COMPLETED: "Completed",
  ERROR: "Error",
  TURN_LIMIT: "Step limit",
};

const OUTCOME_CLASS: Record<AgentMessageRow["outcome"], string> = {
  RUNNING: "bg-sky-100 text-sky-800",
  COMPLETED: "bg-emerald-100 text-emerald-800",
  ERROR: "bg-red-100 text-red-800",
  TURN_LIMIT: "bg-amber-100 text-amber-800",
};

const STEP_CLASS: Record<AgentStepRow["outcome"], string> = {
  RAN: "bg-emerald-100 text-emerald-800",
  ERROR: "bg-red-100 text-red-800",
  REFUSED: "bg-amber-100 text-amber-800",
  APPROVAL_REQUESTED: "bg-violet-100 text-violet-800",
  UNKNOWN_TOOL: "bg-red-100 text-red-800",
};

const ALL_OUTCOMES = "all";

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDuration(ms: number | null): string {
  if (ms === null) return "";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function formatInput(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

export default function AgentMessagesPage() {
  const { data: session, status } = useSession();
  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState("");
  const [outcome, setOutcome] = useState<string>(ALL_OUTCOMES);
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const isSuperAdmin = session?.user?.role === "SUPER_ADMIN";

  const { data, isLoading, isError, isFetching } = useQuery({
    queryKey: ["agent-messages", query, outcome, page],
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(page), limit: "25" });
      if (query) params.set("q", query);
      if (outcome !== ALL_OUTCOMES) params.set("outcome", outcome);
      const res = await fetch(`/api/agent/messages?${params.toString()}`);
      if (!res.ok) throw new Error(`Failed to load agent messages (${res.status})`);
      return (await res.json()) as MessagesResponse;
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
          Agent messages can name real attendees and are restricted to super admins.
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
          <MessagesSquare className="h-6 w-6 text-primary" />
          Agent Messages
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          What people ask the AI Agent, what it replied, and each action it took with its exact
          input. Super-admin only; kept for 180 days.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="h-4 w-4 absolute left-2.5 top-2.5 text-muted-foreground" />
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") runSearch();
            }}
            placeholder="Search messages and replies…"
            className="pl-8"
          />
        </div>
        <Select
          value={outcome}
          onValueChange={(v) => {
            setOutcome(v);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-[160px]" aria-label="Outcome">
            <SelectValue placeholder="Any outcome" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_OUTCOMES}>Any outcome</SelectItem>
            {(Object.keys(OUTCOME_LABEL) as AgentMessageRow["outcome"][]).map((o) => (
              <SelectItem key={o} value={o}>
                {OUTCOME_LABEL[o]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button onClick={runSearch} variant="secondary">
          Search
        </Button>
        {(query || outcome !== ALL_OUTCOMES) && (
          <Button
            variant="ghost"
            onClick={() => {
              setSearchInput("");
              setQuery("");
              setOutcome(ALL_OUTCOMES);
              setPage(1);
            }}
          >
            Clear
          </Button>
        )}
      </div>

      <div className="text-sm text-muted-foreground flex items-center gap-2">
        {isFetching && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        {total} {total === 1 ? "conversation" : "conversations"}
        {query && <span>matching “{query}”</span>}
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin mr-2" />
          Loading messages…
        </div>
      ) : isError ? (
        <div className="rounded-lg border border-red-300 bg-red-50 p-6 text-center text-sm text-red-800">
          Couldn’t load agent messages. Please try again.
        </div>
      ) : (data?.runs.length ?? 0) === 0 ? (
        <div className="rounded-lg border bg-card p-10 text-center text-sm text-muted-foreground">
          {query || outcome !== ALL_OUTCOMES
            ? "No conversations match your filters."
            : "No agent messages recorded yet."}
        </div>
      ) : (
        <ul className="space-y-3">
          {data!.runs.map((row) => {
            const isOpen = expanded[row.id];
            const who = row.user?.name || row.user?.email || row.userId;
            return (
              <li key={row.id} className="rounded-lg border bg-card p-4" data-testid="agent-message-row">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground mb-2">
                  <span className="font-medium text-foreground">{who}</span>
                  <span className="rounded bg-muted px-1.5 py-0.5">{row.role}</span>
                  {row.organization && <span>· {row.organization.name}</span>}
                  {row.event ? <span>· {row.event.name}</span> : <span>· whole organisation</span>}
                  <span className="ml-auto">{formatWhen(row.startedAt)}</span>
                </div>

                <div className="flex flex-wrap items-center gap-2 text-xs mb-2">
                  <span className={`rounded px-1.5 py-0.5 font-medium ${OUTCOME_CLASS[row.outcome]}`}>
                    {OUTCOME_LABEL[row.outcome]}
                    {row.errorClass ? ` (${row.errorClass})` : ""}
                  </span>
                  <span className="text-muted-foreground">
                    {row.toolCalls} {row.toolCalls === 1 ? "tool call" : "tool calls"} · {row.writes}{" "}
                    {row.writes === 1 ? "write" : "writes"} · {row.refusals} refused · {row.toolErrors}{" "}
                    {row.toolErrors === 1 ? "error" : "errors"}
                    {row.approvedTool ? ` · approved ${row.approvedTool}` : ""}
                    {row.durationMs !== null ? ` · ${formatDuration(row.durationMs)}` : ""}
                  </span>
                </div>

                <p className="text-sm font-medium whitespace-pre-wrap">{row.message ?? "(message not stored)"}</p>

                <div className="mt-2">
                  <button
                    onClick={() => setExpanded((prev) => ({ ...prev, [row.id]: !prev[row.id] }))}
                    className="text-xs text-primary hover:underline"
                  >
                    {isOpen ? "Hide reply and tool calls" : "Show reply and tool calls"}
                  </button>
                  {isOpen && (
                    <div className="mt-2 space-y-3">
                      <p className="text-sm text-muted-foreground whitespace-pre-wrap border-l-2 border-muted pl-3">
                        {row.reply || "(no reply text)"}
                      </p>
                      {row.steps.length > 0 && (
                        <ol className="space-y-2">
                          {row.steps.map((s) => (
                            <li key={s.seq} className="rounded border bg-muted/30 p-2 text-xs">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="font-mono font-medium">{s.tool}</span>
                                <span className={`rounded px-1.5 py-0.5 ${STEP_CLASS[s.outcome]}`}>{s.outcome}</span>
                                {s.code && <span className="font-mono text-muted-foreground">{s.code}</span>}
                                {s.write && <span className="rounded bg-muted px-1.5 py-0.5">write</span>}
                                {s.approved && <span className="rounded bg-muted px-1.5 py-0.5">approved</span>}
                                <span className="ml-auto text-muted-foreground">{formatDuration(s.durationMs)}</span>
                              </div>
                              {s.input !== null && s.input !== undefined && (
                                <details className="mt-1">
                                  <summary className="cursor-pointer text-muted-foreground">Input</summary>
                                  <pre className="mt-1 max-h-64 overflow-auto rounded bg-background p-2 text-[11px] whitespace-pre-wrap break-all">
                                    {formatInput(s.input)}
                                  </pre>
                                </details>
                              )}
                            </li>
                          ))}
                        </ol>
                      )}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {total > limit && (
        <div className="flex items-center justify-between pt-2">
          <Button variant="outline" size="sm" disabled={page <= 1 || isFetching} onClick={() => setPage((p) => Math.max(1, p - 1))}>
            <ChevronLeft className="h-4 w-4 mr-1" /> Previous
          </Button>
          <span className="text-sm text-muted-foreground">
            Page {page} of {totalPages}
          </span>
          <Button variant="outline" size="sm" disabled={page >= totalPages || isFetching} onClick={() => setPage((p) => p + 1)}>
            Next <ChevronRight className="h-4 w-4 ml-1" />
          </Button>
        </div>
      )}
    </div>
  );
}
