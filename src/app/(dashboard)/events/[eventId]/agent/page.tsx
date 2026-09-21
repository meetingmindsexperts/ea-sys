"use client";

// The Event Agent opened from an event: the same chat as /agent with this
// event pre-selected. The link opens the organisation-level door with the
// event still selected, where the person can switch or clear it.

import Link from "next/link";
import { useParams } from "next/navigation";
import { AgentChat } from "@/components/agent/agent-chat";

export default function EventAgentPage() {
  const { eventId } = useParams<{ eventId: string }>();
  return (
    <AgentChat
      eventId={eventId}
      headerExtra={
        <Link
          href={`/agent?event=${encodeURIComponent(eventId)}`}
          className="text-sm text-primary underline-offset-4 hover:underline"
        >
          Open the organisation-wide agent
        </Link>
      }
    />
  );
}
