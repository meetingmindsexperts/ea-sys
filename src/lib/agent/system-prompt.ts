import { db } from "@/lib/db";

/** Strip characters that could break the system prompt markdown structure */
function sanitize(value: string): string {
  return value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "").slice(0, 200);
}

export async function buildSystemPrompt(
  eventId: string,
  organizationId: string
): Promise<string> {
  const event = await db.event.findFirst({
    where: { id: eventId, organizationId },
    select: {
      name: true,
      status: true,
      startDate: true,
      endDate: true,
      venue: true,
      city: true,
      country: true,
      specialty: true,
      eventType: true,
      _count: {
        select: {
          registrations: true,
          speakers: true,
          eventSessions: true,
          tracks: true,
        },
      },
    },
  });

  const name = sanitize(event?.name ?? "this event");
  const status = sanitize(event?.status ?? "UNKNOWN");
  const startDate = event?.startDate
    ? new Date(event.startDate).toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    : "TBD";
  const endDate = event?.endDate
    ? new Date(event.endDate).toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    : "TBD";

  const venue = [event?.venue, event?.city, event?.country]
    .filter(Boolean)
    .map((v) => sanitize(v!))
    .join(", ") || "Not set";

  const counts = event?._count ?? {
    registrations: 0,
    speakers: 0,
    eventSessions: 0,
    tracks: 0,
  };

  const today = new Date().toISOString().split("T")[0];

  return `You are an AI event management assistant for "${name}".

## Event Details
- Status: ${status}
- Type: ${event?.eventType ?? "CONFERENCE"}
- Dates: ${startDate} to ${endDate}
- Venue: ${venue}
- Specialty: ${event?.specialty ?? "General"}

## Current Stats
- Registrations: ${counts.registrations}
- Speakers: ${counts.speakers}
- Sessions: ${counts.eventSessions}
- Tracks: ${counts.tracks}

## Today's Date
${today}

## Your Role
You help organizers set up and manage their event efficiently using natural language commands. You have tools to list and create registrations, speakers, sessions, tracks, ticket types (with auto-generated Early Bird, Standard, and Onsite pricing tiers), and send bulk emails.

## Guidelines
1. **Check before creating**: Use list tools first to understand current state and avoid duplicates.
2. **One at a time**: When creating multiple items (e.g., "3 tracks"), call the create tool once per item — never batch multiple creates into a single tool call.
3. **Email confirmation**: Before calling send_bulk_email, always tell the user how many recipients will receive the email and what you are about to send. Wait for the agentic loop to continue naturally.
4. **No deletes**: You cannot delete any records. Only listing and creating are supported.
5. **Error handling**: If a tool returns an error, explain it clearly and suggest alternatives.
6. **Track IDs**: When creating sessions in a specific track, first call list_tracks to get the track's ID, then use that ID in create_session.
7. **Speaker IDs**: When assigning speakers to sessions, first call list_speakers to get IDs.
8. **Be concise**: After completing tasks, summarize what was done in 2-3 sentences.`;
}
