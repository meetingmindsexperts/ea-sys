"use client";

/**
 * The shared CRM inbox — every email conversation with sponsors, org-wide
 * (owner decision: one bulk inbox for all CRM staff; MEMBER never sees it —
 * the API enforces that, this component just renders what it's given).
 *
 * Two panes: threads left (unread dot, deal chip, counterparty), conversation
 * right with a reply composer. Inbound HTML is UNTRUSTED and renders only
 * inside a sandboxed iframe (no scripts, no same-origin) — the same
 * containment the admin docs viewer uses.
 */
import { useEffect, useMemo, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import { AlertTriangle, ArrowDownLeft, ArrowUpRight, Inbox, Loader2, Mail, Paperclip } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  useCrmInboxThread,
  useCrmInboxThreads,
} from "@/crm/hooks/use-crm-api";
import type { CrmInboxMessageRow, CrmInboxThreadRow } from "@/crm/lib/crm-types";

function threadTitle(t: CrmInboxThreadRow): string {
  if (t.crmContact) return `${t.crmContact.firstName} ${t.crmContact.lastName}`.trim();
  return t.counterpartyName || t.counterpartyEmail;
}

function MessageBubble({ message }: { message: CrmInboxMessageRow }) {
  const inbound = message.direction === "INBOUND";
  const sender = inbound
    ? message.fromName || message.fromEmail
    : message.sentBy
      ? `${message.sentBy.firstName} ${message.sentBy.lastName}`.trim()
      : message.fromName || "You";

  return (
    <div className={`flex ${inbound ? "justify-start" : "justify-end"}`}>
      <div
        className={`max-w-[85%] rounded-lg border px-3 py-2 text-sm ${
          inbound ? "bg-muted/40" : "border-sky-200 bg-sky-50/60"
        }`}
      >
        <p className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
          {inbound ? (
            <ArrowDownLeft className="h-3 w-3 text-emerald-600" />
          ) : (
            <ArrowUpRight className="h-3 w-3 text-sky-600" />
          )}
          <span className="font-medium text-foreground/80">{sender}</span>
          <span>· {formatDistanceToNow(new Date(message.createdAt), { addSuffix: true })}</span>
        </p>

        {inbound && message.unverifiedSender && (
          <p className="mb-1.5 flex items-center gap-1.5 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] font-medium text-amber-800">
            <AlertTriangle className="h-3 w-3 shrink-0" />
            Unverified sender — the From address didn&apos;t match this contact. Confirm any
            request (esp. payment/bank changes) out of band before acting.
          </p>
        )}

        {message.textBody ? (
          <p className="whitespace-pre-wrap break-words">{message.textBody}</p>
        ) : message.htmlBody ? (
          // Sender-authored HTML — sandboxed: no scripts, no same-origin access.
          <iframe
            sandbox=""
            srcDoc={message.htmlBody}
            title="Email content"
            className="h-64 w-full rounded border-0 bg-white"
          />
        ) : (
          <p className="text-muted-foreground italic">(no content)</p>
        )}

        {(message.attachments?.length ?? 0) > 0 && (
          <ul className="mt-2 space-y-1 border-t pt-2">
            {message.attachments!.map((a, i) => (
              <li key={i}>
                <a
                  href={`/api/crm/inbox/messages/${message.id}/attachments/${i}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-xs text-sky-700 hover:underline"
                >
                  <Paperclip className="h-3 w-3" />
                  {a.filename}
                  <span className="tabular-nums text-muted-foreground">({(a.size / 1024).toFixed(0)} KB)</span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export function CrmInbox() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const selectedId = searchParams.get("thread");

  const { data, isLoading, isError } = useCrmInboxThreads();
  const { data: detail, isLoading: detailLoading } = useCrmInboxThread(selectedId);

  const bottomRef = useRef<HTMLDivElement>(null);

  const threads = useMemo(() => data?.threads ?? [], [data?.threads]);
  const thread = detail?.thread;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [thread?.messages.length, selectedId]);

  function select(id: string) {
    router.replace(`/crm/inbox?thread=${id}`, { scroll: false });
  }

  if (isLoading) {
    return <div className="h-64 animate-pulse rounded-lg border bg-muted/30" />;
  }
  if (isError) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive">
        Couldn&apos;t load the inbox — please try again.
      </div>
    );
  }

  return (
    <div className="grid min-h-[32rem] grid-cols-1 gap-4 lg:grid-cols-[minmax(16rem,22rem)_1fr]">
      {/* ── Thread list ──────────────────────────────────────────────────── */}
      <div className="overflow-hidden rounded-lg border bg-card">
        <div className="border-b px-3 py-2 text-sm font-medium">
          Conversations
          {(data?.unreadCount ?? 0) > 0 && (
            <Badge className="ml-2 bg-sky-600 text-[10px]">{data!.unreadCount} unread</Badge>
          )}
        </div>
        {threads.length === 0 ? (
          <div className="flex flex-col items-center gap-2 p-8 text-center text-sm text-muted-foreground">
            <Inbox className="h-8 w-8 opacity-40" />
            No conversations yet — emails sent from a deal (and their replies) will appear here.
          </div>
        ) : (
          <ul className="max-h-[40rem] divide-y overflow-y-auto">
            {threads.map((t) => (
              <li key={t.id}>
                <button
                  onClick={() => select(t.id)}
                  className={`w-full px-3 py-2.5 text-left transition-colors hover:bg-muted/40 ${
                    t.id === selectedId ? "bg-muted/60" : ""
                  }`}
                >
                  <span className="flex items-center gap-2">
                    {t.hasUnread && <span className="h-2 w-2 shrink-0 rounded-full bg-sky-600" />}
                    <span className={`min-w-0 flex-1 truncate text-sm ${t.hasUnread ? "font-semibold" : ""}`}>
                      {threadTitle(t)}
                    </span>
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {formatDistanceToNow(new Date(t.lastMessageAt), { addSuffix: true })}
                    </span>
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-muted-foreground">{t.subject}</span>
                  {t.deal && (
                    <Badge variant="outline" className="mt-1 max-w-full truncate text-[10px] font-normal">
                      {t.deal.name}
                    </Badge>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ── Conversation ─────────────────────────────────────────────────── */}
      <div className="flex flex-col overflow-hidden rounded-lg border bg-card">
        {!selectedId ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
            <Inbox className="h-10 w-10 opacity-30" />
            Select a conversation
          </div>
        ) : detailLoading || !thread ? (
          <div className="flex flex-1 items-center justify-center p-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            <div className="border-b px-4 py-3">
              <p className="truncate text-sm font-semibold">{thread.subject}</p>
              <p className="truncate text-xs text-muted-foreground">
                {thread.counterpartyName ? `${thread.counterpartyName} · ` : ""}
                {thread.counterpartyEmail}
                {thread.deal && (
                  <>
                    {" · "}
                    <a href={`/crm/deals/${thread.deal.id}`} className="text-sky-700 hover:underline">
                      {thread.deal.name}
                    </a>
                  </>
                )}
              </p>
            </div>

            <div className="flex-1 space-y-3 overflow-y-auto p-4">
              {thread.messages.map((m) => (
                <MessageBubble key={m.id} message={m} />
              ))}
              <div ref={bottomRef} />
            </div>

            {/* Read-only inbox: sending is centralized on the deal (owner
                decision) — no compose here. To respond, open the deal and use
                its Email action. */}
            <div className="flex items-center justify-between gap-2 border-t bg-muted/20 p-3 text-xs text-muted-foreground">
              <span>Replies are sent from the deal, not here.</span>
              {thread.deal && (
                <Button asChild size="sm" variant="outline">
                  <a href={`/crm/deals/${thread.deal.id}`}>
                    <Mail className="mr-2 h-3.5 w-3.5" />
                    Email from the deal
                  </a>
                </Button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
