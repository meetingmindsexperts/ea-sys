/**
 * Live poll drafts (Oct 30, 2026). The ONE create path for a webinar's live
 * poll: the Webinar Console's POST route and the agent's create_live_poll
 * tool both call it, so a draft is shaped, stored and audited the same way
 * from either door (services README, "no cross-caller duplication").
 *
 * A draft is never live: launching it is a separate, person-only action on
 * the console (PATCH .../webinar/polls/[pollId]).
 */
import { randomUUID } from "node:crypto";
import { tenantTransaction } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import type { PollDraft } from "@/lib/webinar/live-polls";

export type LivePollServiceSource = "rest" | "mcp" | "agent";

export interface LivePollScope {
  eventId: string;
  organizationId: string;
  /** The webinar's room session the poll belongs to. */
  sessionId: string;
  userId: string | null;
  source: LivePollServiceSource;
}

export type CreateLivePollDraftResult = { ok: true; pollId: string };

export async function createLivePollDraft(scope: LivePollScope, draft: PollDraft): Promise<CreateLivePollDraftResult> {
  const pollId = await tenantTransaction(async (tx) => {
    const poll = await tx.livePoll.create({
      data: {
        eventId: scope.eventId,
        organizationId: scope.organizationId,
        sessionId: scope.sessionId,
        question: draft.question,
        options: draft.options.map((label) => ({ id: randomUUID().slice(0, 8), label })),
        allowMultiple: draft.allowMultiple,
      },
      select: { id: true },
    });
    await tx.auditLog.create({
      data: {
        eventId: scope.eventId,
        organizationId: scope.organizationId,
        userId: scope.userId,
        action: "LIVE_POLL_CREATED",
        entityType: "LivePoll",
        entityId: poll.id,
        changes: { question: draft.question, options: draft.options.length, source: scope.source },
      },
    });
    return poll.id;
  });
  apiLogger.info({ eventId: scope.eventId, pollId, userId: scope.userId, source: scope.source }, "live-polls:created");
  return { ok: true, pollId };
}
