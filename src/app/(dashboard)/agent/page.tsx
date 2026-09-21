"use client";

// The organisation-level door of the Event Agent (architecture review §4.3).
// An event is optional: pick one here, or arrive with ?event=<id> from an
// event's own AI Agent entry. The conversation is keyed on the chosen event.

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AgentChat } from "@/components/agent/agent-chat";
import { EventPicker, type PickerEvent } from "@/components/agent/event-picker";
import { useEvents } from "@/hooks/use-api";

function AgentPageInner() {
  const router = useRouter();
  const params = useSearchParams();
  const eventId = params.get("event") || null;
  const { data } = useEvents();
  const raw: unknown = data;
  const events: PickerEvent[] = Array.isArray(raw)
    ? (raw as PickerEvent[])
    : (((raw as { events?: PickerEvent[] } | undefined)?.events ?? []) as PickerEvent[]);

  const setEvent = (id: string | null) => {
    router.replace(id ? `/agent?event=${encodeURIComponent(id)}` : "/agent");
  };

  return (
    <AgentChat
      eventId={eventId}
      headerExtra={
        <div className="flex items-center gap-3 text-sm">
          <span className="text-muted-foreground">Working on</span>
          <EventPicker events={events} value={eventId} onChange={setEvent} />
        </div>
      }
    />
  );
}

export default function AgentPage() {
  return (
    <Suspense fallback={null}>
      <AgentPageInner />
    </Suspense>
  );
}
