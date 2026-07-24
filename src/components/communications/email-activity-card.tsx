"use client";

import { useRef, useState } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { Activity, Eye, Loader2, Mail, Search, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ViewEmailDialog } from "@/components/communications/view-email-dialog";
import { formatTemplateLabel } from "@/lib/email-template-slugs";

interface SummaryRow {
  userId: string | null;
  name: string;
  email: string | null;
  sent: number;
  failed: number;
}

interface ActivityRow {
  id: string;
  to: string;
  subject: string;
  templateSlug: string | null;
  status: "SENT" | "FAILED";
  errorMessage: string | null;
  createdAt: string;
  hasBody: boolean;
  triggeredBy: { id: string; firstName: string; lastName: string; email: string } | null;
}

interface ActivityResponse {
  rows: ActivityRow[];
  total: number;
  page: number;
  pageSize: number;
  summary: SummaryRow[];
  templateOptions: string[];
  senderOptions: { id: string; name: string }[];
}

const ALL = "__all__";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

export function EmailActivityCard({ eventId }: { eventId: string }) {
  const [senderId, setSenderId] = useState<string>(ALL);
  const [status, setStatus] = useState<string>(ALL);
  const [templateSlug, setTemplateSlug] = useState<string>(ALL);
  const [qInput, setQInput] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [viewEmailId, setViewEmailId] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounce the search box without a setState-in-effect (banned by lint):
  // schedule the applied value from the change handler itself.
  const onSearchChange = (value: string) => {
    setQInput(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setQ(value);
      setPage(1);
    }, 350);
  };

  const params = new URLSearchParams();
  if (senderId !== ALL) params.set("senderId", senderId);
  if (status !== ALL) params.set("status", status);
  if (templateSlug !== ALL) params.set("templateSlug", templateSlug);
  if (q) params.set("q", q);
  if (page > 1) params.set("page", String(page));

  const { data, isLoading, isError, isFetching } = useQuery<ActivityResponse>({
    queryKey: ["email-activity", eventId, senderId, status, templateSlug, q, page],
    queryFn: async () => {
      const res = await fetch(`/api/events/${eventId}/email-activity?${params.toString()}`);
      if (!res.ok) throw new Error(`Failed to load email activity (${res.status})`);
      return res.json();
    },
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });

  const summary = data?.summary ?? [];
  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const pageSize = data?.pageSize ?? 30;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const totalSent = summary.reduce((n, s) => n + s.sent, 0);
  const totalFailed = summary.reduce((n, s) => n + s.failed, 0);

  const resetPageSet = (setter: (v: string) => void) => (v: string) => {
    setter(v);
    setPage(1);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Activity className="h-5 w-5 text-[#00aade]" />
          Email Activity
        </CardTitle>
        <CardDescription>
          Every email sent for this event — who sent it, to whom, and whether it
          landed. {totalSent + totalFailed > 0 && (
            <span className="font-medium text-foreground">
              {totalSent} sent{totalFailed > 0 ? `, ${totalFailed} failed` : ""}.
            </span>
          )}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Per-team-member rollup — click a sender to filter the table below. */}
        {summary.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {summary.map((s) => {
              const active = s.userId != null && senderId === s.userId;
              const clickable = s.userId != null;
              return (
                <button
                  key={s.userId ?? "__system__"}
                  type="button"
                  disabled={!clickable}
                  onClick={() => {
                    if (!clickable) return;
                    setSenderId(active ? ALL : (s.userId as string));
                    setPage(1);
                  }}
                  className={[
                    "flex items-center gap-2 rounded-lg border px-3 py-2 text-left transition-colors",
                    clickable ? "hover:border-[#00aade] hover:bg-[#00aade]/5" : "cursor-default",
                    active ? "border-[#00aade] bg-[#00aade]/10" : "bg-card",
                  ].join(" ")}
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#00aade]/10 text-[11px] font-semibold text-[#0090b8]">
                    {s.userId ? initials(s.name) : <Users className="h-3.5 w-3.5" />}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium leading-tight">{s.name}</span>
                    <span className="block text-xs text-muted-foreground leading-tight">
                      {s.sent} sent{s.failed > 0 ? ` · ${s.failed} failed` : ""}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {/* Filter bar */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[200px] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={qInput}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="Search recipient or subject…"
              className="pl-8"
            />
          </div>
          <Select value={senderId} onValueChange={resetPageSet(setSenderId)}>
            <SelectTrigger className="w-[170px]">
              <SelectValue placeholder="Sender" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All senders</SelectItem>
              {(data?.senderOptions ?? []).map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={templateSlug} onValueChange={resetPageSet(setTemplateSlug)}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Template" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All templates</SelectItem>
              {(data?.templateOptions ?? []).map((t) => (
                <SelectItem key={t} value={t}>
                  {formatTemplateLabel(t)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={status} onValueChange={resetPageSet(setStatus)}>
            <SelectTrigger className="w-[130px]">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Any status</SelectItem>
              <SelectItem value="SENT">Sent</SelectItem>
              <SelectItem value="FAILED">Failed</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Table */}
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Subject</TableHead>
                <TableHead className="hidden md:table-cell">To</TableHead>
                <TableHead className="hidden lg:table-cell">Template</TableHead>
                <TableHead className="hidden sm:table-cell">Sent by</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden md:table-cell">When</TableHead>
                <TableHead className="w-[1%]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-sm text-muted-foreground">
                    <Loader2 className="mr-2 inline h-4 w-4 animate-spin" /> Loading…
                  </TableCell>
                </TableRow>
              )}
              {isError && (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-sm text-red-500">
                    Couldn&apos;t load email activity.
                  </TableCell>
                </TableRow>
              )}
              {!isLoading && !isError && rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-sm text-muted-foreground">
                    <Mail className="mr-2 inline h-4 w-4" /> No emails match these filters.
                  </TableCell>
                </TableRow>
              )}
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="max-w-[260px]">
                    <span className="block truncate font-medium">{row.subject}</span>
                    {row.status === "FAILED" && row.errorMessage && (
                      <span className="block truncate text-xs text-red-500">{row.errorMessage}</span>
                    )}
                  </TableCell>
                  <TableCell className="hidden max-w-[180px] md:table-cell">
                    <span className="block truncate text-sm text-muted-foreground">{row.to}</span>
                  </TableCell>
                  <TableCell className="hidden lg:table-cell">
                    {row.templateSlug ? (
                      <span className="inline-flex items-center rounded-full border bg-muted px-2 py-0.5 text-xs font-medium text-foreground/70">
                        {formatTemplateLabel(row.templateSlug)}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    {row.triggeredBy ? (
                      <span className="text-sm">
                        {row.triggeredBy.firstName} {row.triggeredBy.lastName}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">System</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={row.status === "SENT" ? "secondary" : "destructive"}>
                      {row.status === "SENT" ? "Sent" : "Failed"}
                    </Badge>
                  </TableCell>
                  <TableCell className="hidden whitespace-nowrap text-sm text-muted-foreground md:table-cell">
                    {formatDistanceToNow(new Date(row.createdAt), { addSuffix: true })}
                  </TableCell>
                  <TableCell>
                    {row.hasBody && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 gap-1 px-2 text-[#0090b8]"
                        onClick={() => setViewEmailId(row.id)}
                      >
                        <Eye className="h-3.5 w-3.5" /> View
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        {/* Pagination */}
        {total > pageSize && (
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>
              Page {page} of {totalPages} · {total} email{total === 1 ? "" : "s"}
              {isFetching && <Loader2 className="ml-2 inline h-3 w-3 animate-spin" />}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </CardContent>

      <ViewEmailDialog emailLogId={viewEmailId} onClose={() => setViewEmailId(null)} />
    </Card>
  );
}
