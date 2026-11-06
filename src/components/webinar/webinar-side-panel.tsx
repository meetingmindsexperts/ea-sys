"use client";

import { useCallback, useState } from "react";
import { AskQuestionBox } from "./ask-question-box";
import { ChatPanel } from "./chat-panel";

type Tab = "chat" | "qa";

/**
 * The column beside the stream: Q&A (with live polls) alone, or Chat and Q&A as two tabs once the
 * producer switches chat on (Nov 6, 2026). Both stay mounted so neither stops refreshing. So that
 * nothing arrives unseen behind the other tab (owner, Nov 6): the Q&A tab shows "Poll" while a poll
 * waits for this viewer's answer, and a dot when a question is shared or theirs is answered; the
 * Chat tab shows a dot when messages from others arrive. Opening a tab clears its dot.
 */
export function WebinarSidePanel({ slug, sessionId }: { slug: string; sessionId: string }) {
  const [chatOn, setChatOn] = useState(false);
  const [tab, setTab] = useState<Tab>("chat");
  const [pollWaiting, setPollWaiting] = useState(false);
  const [unread, setUnread] = useState(false);
  const [qaUnread, setQaUnread] = useState(false);
  const [tabRef] = useState(() => ({ current: "chat" as Tab }));

  const onEnabledChange = useCallback((enabled: boolean) => setChatOn(enabled), []);
  // Only a tab that is NOT in front gets a dot.
  const onNewMessage = useCallback(() => {
    if (tabRef.current !== "chat") setUnread(true);
  }, [tabRef]);
  // Q&A alone (chat off) is always in front: nothing to badge (review of f35de631).
  const onNewQaActivity = useCallback(() => {
    if (chatOn && tabRef.current !== "qa") setQaUnread(true);
  }, [chatOn, tabRef]);
  const show = (next: Tab) => {
    setTab(next);
    tabRef.current = next;
    if (next === "chat") setUnread(false);
    else setQaUnread(false);
  };
  const chatInFront = chatOn && tab === "chat";

  return (
    <div className="space-y-3">
      {chatOn && (
        <div role="tablist" aria-label="Chat and questions" className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1 text-sm">
          <TabButton active={tab === "chat"} onClick={() => show("chat")} badge={unread && tab !== "chat" ? "dot" : null}>
            Chat
          </TabButton>
          <TabButton active={tab === "qa"} onClick={() => show("qa")} badge={qaBadge(tab, pollWaiting, qaUnread)}>
            Q&amp;A
          </TabButton>
        </div>
      )}
      <div hidden={!chatInFront}>
        <ChatPanel slug={slug} sessionId={sessionId} onEnabledChange={onEnabledChange} onNewMessage={onNewMessage} />
      </div>
      <div hidden={chatInFront}>
        <AskQuestionBox
          slug={slug}
          sessionId={sessionId}
          onPollWaitingChange={setPollWaiting}
          onNewActivity={onNewQaActivity}
        />
      </div>
    </div>
  );
}

/** A waiting poll outranks a plain dot; nothing on the tab in front. */
function qaBadge(tab: Tab, pollWaiting: boolean, unread: boolean): "dot" | "Poll" | null {
  if (tab === "qa") return null;
  if (pollWaiting) return "Poll";
  return unread ? "dot" : null;
}

function TabButton({
  active,
  onClick,
  badge,
  children,
}: {
  active: boolean;
  onClick: () => void;
  badge: "dot" | string | null;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 font-medium transition-colors ${
        active ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
      {badge === "dot" && <span className="h-2 w-2 rounded-full bg-primary" aria-label="Something new" />}
      {badge && badge !== "dot" && (
        <span className="rounded bg-amber-500 px-1.5 text-[10px] font-semibold uppercase text-white">{badge}</span>
      )}
    </button>
  );
}
