"use client";

/**
 * The shared CRM inbox — every email conversation with sponsors, org-wide
 * (owner decision: one bulk inbox for all CRM staff; MEMBER never sees it —
 * the API enforces that, this component just renders what it's given).
 *
 * Two panes: threads left, conversation right. Since Oct 27, 2026 (phase 1 of
 * docs/CRM_INBOX_PLAN.md) the list has folders (Inbox, Sent, Archived), search,
 * Unread / Mine filters, a deal filter (click a thread's deal chip) and "load
 * more"; a conversation can be archived or marked unread. Replying still
 * happens on the deal until phase 2. Inbound HTML is UNTRUSTED and renders only
 * inside a sandboxed iframe (no scripts, no same-origin) — the same containment
 * the admin docs viewer uses.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  ArrowDownLeft,
  ArrowUpRight,
  Inbox,
  Loader2,
  Mail,
  MailWarning,
  Paperclip,
  Search,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useSettled } from "@/hooks/use-settled";
import {
  useCrmInbox,
  useCrmInboxThread,
  useUpdateInboxThread,
  type CrmInboxFilters,
} from "@/crm/hooks/use-crm-api";
import type { CrmInboxMessageRow, CrmInboxThreadRow } from "@/crm/lib/crm-types";

function threadTitle(t: CrmInboxThreadRow): string {
  if (t.crmContact) return `${t.crmContact.firstName} ${t.crmContact.lastName}`.trim();
  return t.counterpartyName || t.counterpartyEmail;
}

function messageSender(message: CrmInboxMessageRow, inbound: boolean): string {
  if (inbound) return message.fromName || message.fromEmail;
  if (message.sentBy) return `${message.sentBy.firstName} ${message.sentBy.lastName}`.trim();
  return message.fromName || "You";
}

function MessageBody({ message }: { message: CrmInboxMessageRow }) {
  if (message.textBody) return <p className="whitespace-pre-wrap break-words">{message.textBody}</p>;
  if (message.htmlBody) {
    return (
      // Sender-authored HTML — sandboxed: no scripts, no same-origin access.
      <iframe
        sandbox=""
        srcDoc={message.htmlBody}
        title="Email content"
        className="h-64 w-full rounded border-0 bg-white"
      />
    );
  }
  return <p className="text-muted-foreground italic">(no content)</p>;
}

function MessageBubble({ message }: { message: CrmInboxMessageRow }) {
  const inbound = message.direction === "INBOUND";
  const sender = messageSender(message, inbound);

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

        <MessageBody message={message} />

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

type Folder = CrmInboxFilters["folder"];

function asFolder(v: string | null): Folder {
  return v === "sent" || v === "archived" ? v : "inbox";
}

const EMPTY_TEXT: Record<Folder, string> = {
  inbox: "No replies yet. When a sponsor answers an email sent from a deal, it lands here.",
  sent: "Nothing sent yet. Emails sent from a deal appear here.",
  archived: "Nothing archived.",
};

function emptyText(folder: Folder, filtered: boolean): string {
  return filtered ? "No conversations match these filters." : EMPTY_TEXT[folder];
}

/** A small on/off filter chip. */
function FilterChip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <Button type="button" size="sm" variant={on ? "default" : "outline"} className="h-7 px-2.5 text-xs" onClick={onClick}>
      {children}
    </Button>
  );
}

function ThreadListItem({
  t,
  selected,
  onSelect,
  onDeal,
}: {
  t: CrmInboxThreadRow;
  selected: boolean;
  onSelect: () => void;
  onDeal: (deal: { id: string; name: string }) => void;
}) {
  return (
    <li className={`px-3 py-2.5 transition-colors hover:bg-muted/40 ${selected ? "bg-muted/60" : ""}`}>
      <button type="button" onClick={onSelect} className="w-full text-left">
        <span className="flex items-center gap-2">
          {t.hasUnread && <span className="h-2 w-2 shrink-0 rounded-full bg-sky-600" aria-label="Unread" />}
          <span className={`min-w-0 flex-1 truncate text-sm ${t.hasUnread ? "font-semibold" : ""}`}>
            {threadTitle(t)}
          </span>
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {formatDistanceToNow(new Date(t.lastMessageAt), { addSuffix: true })}
          </span>
        </span>
        <span className="mt-0.5 block truncate text-xs text-muted-foreground">{t.subject}</span>
      </button>
      {t.deal && (
        <button
          type="button"
          onClick={() => onDeal(t.deal!)}
          title="Show only this deal's conversations"
          className="mt-1 max-w-full"
        >
          <Badge variant="outline" className="max-w-full truncate text-[10px] font-normal hover:bg-muted">
            {t.deal.name}
          </Badge>
        </button>
      )}
    </li>
  );
}

export function CrmInbox() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const selectedId = searchParams.get("thread");
  const folder = asFolder(searchParams.get("folder"));

  const [search, setSearch] = useState("");
  const [unread, setUnread] = useState(false);
  const [mine, setMine] = useState(false);
  const [deal, setDeal] = useState<{ id: string; name: string } | null>(null);
  const q = useSettled(search.trim(), 300);

  const filters: CrmInboxFilters = { folder, unread, mine, dealId: deal?.id, q };
  const list = useCrmInbox(filters);
  const { data: detail, isLoading: detailLoading } = useCrmInboxThread(selectedId);
  const update = useUpdateInboxThread();

  const bottomRef = useRef<HTMLDivElement>(null);
  const threads = useMemo(() => list.data?.pages.flatMap((p) => p.threads) ?? [], [list.data]);
  const unreadCount = list.data?.pages[0]?.unreadCount ?? 0;
  const thread = detail?.thread;
  const filtered = unread || mine || !!deal || !!q;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [thread?.messages.length, selectedId]);

  function go(next: { folder?: Folder; thread?: string | null }) {
    const qs = new URLSearchParams();
    const f = next.folder ?? folder;
    if (f !== "inbox") qs.set("folder", f);
    const t = next.thread === undefined ? selectedId : next.thread;
    if (t) qs.set("thread", t);
    const s = qs.toString();
    router.replace(`/crm/inbox${s ? `?${s}` : ""}`, { scroll: false });
  }

  function setArchived(archived: boolean) {
    if (!thread) return;
    update.mutate(
      { threadId: thread.id, archived },
      // Leave the conversation once it no longer belongs to this folder.
      { onSuccess: () => go({ thread: null }) },
    );
  }

  function markUnread() {
    if (!thread) return;
    // Close it too: an open conversation is re-read (and cleared) on refresh.
    update.mutate({ threadId: thread.id, unread: true }, { onSuccess: () => go({ thread: null }) });
  }

  return (
    <div className="grid min-h-[32rem] grid-cols-1 gap-4 lg:grid-cols-[minmax(18rem,24rem)_1fr]">
      {/* ── Folders, filters and the thread list ─────────────────────────── */}
      <div className="flex flex-col overflow-hidden rounded-lg border bg-card">
        <div className="space-y-2 border-b p-2">
          <Tabs value={folder} onValueChange={(v) => go({ folder: asFolder(v), thread: null })}>
            <TabsList className="w-full">
              <TabsTrigger value="inbox" className="flex-1">
                Inbox
                {unreadCount > 0 && <Badge className="ml-1.5 h-4 bg-sky-600 px-1.5 text-[10px]">{unreadCount}</Badge>}
              </TabsTrigger>
              <TabsTrigger value="sent" className="flex-1">
                Sent
              </TabsTrigger>
              <TabsTrigger value="archived" className="flex-1">
                Archived
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search subject, person, email or deal…"
              aria-label="Search conversations"
              className="h-9 pl-8"
            />
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <FilterChip on={unread} onClick={() => setUnread((v) => !v)}>
              Unread
            </FilterChip>
            <FilterChip on={mine} onClick={() => setMine((v) => !v)}>
              My deals
            </FilterChip>
            {deal && (
              <Badge variant="secondary" className="h-7 max-w-[12rem] gap-1 pr-1 font-normal">
                <span className="truncate">{deal.name}</span>
                <button type="button" onClick={() => setDeal(null)} aria-label="Clear the deal filter">
                  <X className="h-3.5 w-3.5" />
                </button>
              </Badge>
            )}
          </div>
        </div>

        {list.isLoading && <div className="m-3 h-40 animate-pulse rounded-md bg-muted/30" />}
        {list.isError && (
          <p className="p-4 text-sm text-destructive">Couldn&apos;t load the inbox. Please try again.</p>
        )}
        {!list.isLoading && !list.isError && threads.length === 0 && (
          <div className="flex flex-col items-center gap-2 p-8 text-center text-sm text-muted-foreground">
            <Inbox className="h-8 w-8 opacity-40" />
            {emptyText(folder, filtered)}
          </div>
        )}
        {threads.length > 0 && (
          <ul className="max-h-[40rem] flex-1 divide-y overflow-y-auto">
            {threads.map((t) => (
              <ThreadListItem
                key={t.id}
                t={t}
                selected={t.id === selectedId}
                onSelect={() => go({ thread: t.id })}
                onDeal={setDeal}
              />
            ))}
            {list.hasNextPage && (
              <li className="p-2 text-center">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => list.fetchNextPage()}
                  disabled={list.isFetchingNextPage}
                >
                  {list.isFetchingNextPage ? "Loading…" : "Load more"}
                </Button>
              </li>
            )}
          </ul>
        )}
      </div>

      {/* ── Conversation ─────────────────────────────────────────────────── */}
      <div className="flex flex-col overflow-hidden rounded-lg border bg-card">
        {!selectedId && (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
            <Inbox className="h-10 w-10 opacity-30" />
            Select a conversation
          </div>
        )}
        {!!selectedId && (detailLoading || !thread) && (
          <div className="flex flex-1 items-center justify-center p-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        )}
        {!!selectedId && !detailLoading && thread && (
          <>
            <div className="flex items-start gap-2 border-b px-4 py-3">
              <div className="min-w-0 flex-1">
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
              <Button type="button" variant="ghost" size="sm" onClick={markUnread} disabled={update.isPending}>
                <MailWarning className="mr-1.5 h-3.5 w-3.5" />
                Mark unread
              </Button>
              {thread.archivedAt ? (
                <Button type="button" variant="ghost" size="sm" onClick={() => setArchived(false)} disabled={update.isPending}>
                  <ArchiveRestore className="mr-1.5 h-3.5 w-3.5" />
                  Move to Inbox
                </Button>
              ) : (
                <Button type="button" variant="ghost" size="sm" onClick={() => setArchived(true)} disabled={update.isPending}>
                  <Archive className="mr-1.5 h-3.5 w-3.5" />
                  Archive
                </Button>
              )}
            </div>

            <div className="flex-1 space-y-3 overflow-y-auto p-4">
              {thread.messages.map((m) => (
                <MessageBubble key={m.id} message={m} />
              ))}
              <div ref={bottomRef} />
            </div>

            {/* Replying from the inbox is phase 2 of docs/CRM_INBOX_PLAN.md;
                until then a reply is sent from the deal's Email action. */}
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
