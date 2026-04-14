import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import {
  getWebinarPollReport,
  getWebinarQaReport,
  type ZoomPollSubmission,
  type ZoomQaParticipant,
} from "@/lib/zoom";

// Engagement uses the same timing as attendance: Zoom needs ~30 min to
// compile reports, and we stop polling after 30 days.
export const ENGAGEMENT_FETCH_MIN_DELAY_MS = 30 * 60 * 1000;
export const ENGAGEMENT_FETCH_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export type EngagementSyncResult =
  | {
      ok: true;
      status: "synced";
      pollsPersisted: number;
      pollResponsesPersisted: number;
      questionsPersisted: number;
      pollsReportNotReady: boolean;
      qaReportNotReady: boolean;
      durationMs: number;
    }
  | {
      ok: true;
      status: "pending";
      reason: string;
      durationMs: number;
    }
  | {
      ok: false;
      status: "failed";
      reason: string;
      durationMs: number;
    };

/**
 * Parse a Zoom create_time string into a Date.
 * Zoom sometimes returns non-ISO strings ("MMM d, yyyy h:mm:ss AM") — fall
 * back to the current moment if parsing fails rather than skipping the row.
 */
function parseZoomDate(value: string | undefined, fallback: Date): Date {
  if (!value) return fallback;
  const d = new Date(value);
  if (!Number.isNaN(d.getTime())) return d;
  return fallback;
}

/**
 * Collapse Zoom's participant-grouped poll report into:
 *   1. One logical poll per webinar (title + distinct question list)
 *   2. One response row per participant submission
 *
 * Zoom's /report/webinars/{id}/polls endpoint doesn't distinguish between
 * multiple polls run during the same webinar — it returns a flat list of
 * (participant, question, answer) tuples. Zoom's own dashboard collapses
 * the same way, so this is the right approximation.
 */
function extractPollDefinition(submissions: ZoomPollSubmission[]): {
  questionNames: string[];
  rows: Array<{
    participantName: string;
    participantEmail: string | null;
    answers: Record<string, string>;
    submittedAt: Date;
  }>;
} {
  const questionNamesOrdered: string[] = [];
  const seenQuestions = new Set<string>();
  const rows: Array<{
    participantName: string;
    participantEmail: string | null;
    answers: Record<string, string>;
    submittedAt: Date;
  }> = [];

  for (const submission of submissions) {
    const answers: Record<string, string> = {};
    for (const detail of submission.question_details ?? []) {
      if (!detail?.question) continue;
      if (!seenQuestions.has(detail.question)) {
        seenQuestions.add(detail.question);
        questionNamesOrdered.push(detail.question);
      }
      answers[detail.question] = detail.answer ?? "";
    }
    rows.push({
      participantName: submission.name || "Unknown",
      participantEmail: submission.email?.trim() || null,
      answers,
      submittedAt: parseZoomDate(
        submission.first_poll_participation_date_time,
        new Date(),
      ),
    });
  }

  return { questionNames: questionNamesOrdered, rows };
}

/**
 * Fetch + persist polls and Q&A for a single ZoomMeeting row. Idempotent:
 *   - polls: upsert the single logical WebinarPoll by (zoomMeetingId, null),
 *     then delete and re-create responses so the count is always fresh
 *   - Q&A: upsert by (zoomMeetingId, askerName, askedAt)
 *
 * A missing report (404) on either side doesn't fail the whole sync —
 * some webinars have only polls, some only Q&A, some neither. We track
 * each side independently in the result.
 */
export async function syncWebinarEngagement(
  zoomMeetingDbId: string,
): Promise<EngagementSyncResult> {
  const startedAt = Date.now();

  const meeting = await db.zoomMeeting.findUnique({
    where: { id: zoomMeetingDbId },
    select: {
      id: true,
      zoomMeetingId: true,
      meetingType: true,
      eventId: true,
      event: { select: { organizationId: true } },
      session: { select: { endTime: true } },
    },
  });

  if (!meeting) {
    return {
      ok: false,
      status: "failed",
      reason: "zoom-meeting-not-found",
      durationMs: Date.now() - startedAt,
    };
  }

  // Engagement reports only exist for webinar types
  if (meeting.meetingType === "MEETING") {
    return {
      ok: true,
      status: "pending",
      reason: "not a webinar (polls/Q&A are webinar-only)",
      durationMs: Date.now() - startedAt,
    };
  }

  const endedAt = meeting.session?.endTime;
  if (!endedAt) {
    apiLogger.warn(
      { zoomMeetingDbId: meeting.id },
      "webinar-engagement:no-end-time",
    );
    return {
      ok: true,
      status: "pending",
      reason: "anchor session has no endTime",
      durationMs: Date.now() - startedAt,
    };
  }

  const msSinceEnded = Date.now() - endedAt.getTime();
  if (msSinceEnded < ENGAGEMENT_FETCH_MIN_DELAY_MS) {
    return {
      ok: true,
      status: "pending",
      reason: "too soon after end (Zoom report not ready yet)",
      durationMs: Date.now() - startedAt,
    };
  }
  if (msSinceEnded > ENGAGEMENT_FETCH_WINDOW_MS) {
    apiLogger.info(
      { zoomMeetingDbId: meeting.id, msSinceEnded },
      "webinar-engagement:outside-fetch-window",
    );
    return {
      ok: true,
      status: "pending",
      reason: "outside engagement fetch window (>30 days post-event)",
      durationMs: Date.now() - startedAt,
    };
  }

  try {
    const [pollReport, qaReport] = await Promise.all([
      getWebinarPollReport(meeting.event.organizationId, meeting.zoomMeetingId),
      getWebinarQaReport(meeting.event.organizationId, meeting.zoomMeetingId),
    ]);

    const pollsReportNotReady = pollReport === null;
    const qaReportNotReady = qaReport === null;

    // ── Polls ──
    // Zoom's report endpoint doesn't distinguish multiple polls run during
    // the same webinar — it returns flat (participant, question, answer)
    // tuples. We collapse into a single logical WebinarPoll per webinar.
    //
    // The whole block runs in a transaction so that:
    //   1. Concurrent syncs (e.g. manual Sync + chained cron) can't create
    //      duplicate "Webinar Poll" rows. A nullable composite unique key
    //      doesn't enforce uniqueness on NULL in Postgres, so we rely on
    //      the transaction to serialize find-or-create.
    //   2. The deleteMany + createMany for responses is atomic — a crash
    //      between them can't leave us with zero responses.
    let pollsPersisted = 0;
    let pollResponsesPersisted = 0;
    if (pollReport && pollReport.questions && pollReport.questions.length > 0) {
      const { questionNames, rows } = extractPollDefinition(pollReport.questions);
      if (rows.length > 0) {
        const pollTitle = pollReport.topic
          ? `Poll — ${pollReport.topic}`
          : "Webinar Poll";

        await db.$transaction(async (tx) => {
          const existingPoll = await tx.webinarPoll.findFirst({
            where: { zoomMeetingId: meeting.id, zoomPollId: null },
            select: { id: true },
          });

          let pollId: string;
          if (existingPoll) {
            await tx.webinarPoll.update({
              where: { id: existingPoll.id },
              data: {
                title: pollTitle,
                questions: questionNames as unknown as object,
              },
            });
            pollId = existingPoll.id;
          } else {
            const created = await tx.webinarPoll.create({
              data: {
                zoomMeetingId: meeting.id,
                zoomPollId: null,
                title: pollTitle,
                questions: questionNames as unknown as object,
              },
              select: { id: true },
            });
            pollId = created.id;
          }

          // Replace-all strategy — Zoom doesn't give us stable submission ids,
          // so upserting individual rows would require a surrogate key based
          // on (participantEmail, submittedAt). delete + create is simpler
          // and atomic inside the transaction.
          await tx.webinarPollResponse.deleteMany({ where: { pollId } });
          await tx.webinarPollResponse.createMany({
            data: rows.map((r) => ({
              pollId,
              participantName: r.participantName,
              participantEmail: r.participantEmail,
              answers: r.answers as unknown as object,
              submittedAt: r.submittedAt,
            })),
          });
        });

        pollsPersisted = 1;
        pollResponsesPersisted = rows.length;
      }
    }

    // ── Q&A ──
    // Uniqueness key is (zoomMeetingId, askerName, askedAt). When Zoom omits
    // create_time we'd fall back to Date.now() which can collide across
    // rapid-fire questions → upsert overwrites instead of creating. Prefer
    // to skip rows with no create_time rather than silently collapse them.
    let questionsPersisted = 0;
    let questionsSkipped = 0;
    if (qaReport && qaReport.questions && qaReport.questions.length > 0) {
      for (const asker of qaReport.questions as ZoomQaParticipant[]) {
        for (const detail of asker.question_details ?? []) {
          if (!detail?.question) continue;
          if (!detail.create_time) {
            questionsSkipped += 1;
            continue;
          }
          const askedAt = new Date(detail.create_time);
          if (Number.isNaN(askedAt.getTime())) {
            questionsSkipped += 1;
            apiLogger.warn(
              {
                zoomMeetingDbId: meeting.id,
                askerName: asker.name,
                rawCreateTime: detail.create_time,
              },
              "webinar-engagement:qa-invalid-create-time",
            );
            continue;
          }
          const askerName = asker.name || "Anonymous";
          try {
            await db.webinarQuestion.upsert({
              where: {
                zoomMeetingId_askerName_askedAt: {
                  zoomMeetingId: meeting.id,
                  askerName,
                  askedAt,
                },
              },
              create: {
                zoomMeetingId: meeting.id,
                askerName,
                askerEmail: asker.email?.trim() || null,
                question: detail.question,
                answer: detail.answer ?? null,
                askedAt,
              },
              update: {
                question: detail.question,
                answer: detail.answer ?? null,
                askerEmail: asker.email?.trim() || null,
              },
            });
            questionsPersisted += 1;
          } catch (rowErr) {
            questionsSkipped += 1;
            apiLogger.error(
              { err: rowErr, zoomMeetingDbId: meeting.id, askerName },
              "webinar-engagement:qa-upsert-failed",
            );
          }
        }
      }
    }

    // Mark engagement synced. Wrapped in try/catch — upserts above already
    // succeeded, so a marker failure just means the next cron tick re-runs
    // (still idempotent).
    try {
      await db.zoomMeeting.update({
        where: { id: meeting.id },
        data: { lastEngagementSyncAt: new Date() },
      });
    } catch (markErr) {
      apiLogger.error(
        { err: markErr, zoomMeetingDbId: meeting.id },
        "webinar-engagement:sync-marker-update-failed",
      );
    }

    const durationMs = Date.now() - startedAt;
    apiLogger.info(
      {
        zoomMeetingDbId: meeting.id,
        eventId: meeting.eventId,
        pollsPersisted,
        pollResponsesPersisted,
        questionsPersisted,
        questionsSkipped,
        pollsReportNotReady,
        qaReportNotReady,
        durationMs,
      },
      "webinar-engagement:synced",
    );

    return {
      ok: true,
      status: "synced",
      pollsPersisted,
      pollResponsesPersisted,
      questionsPersisted,
      pollsReportNotReady,
      qaReportNotReady,
      durationMs,
    };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const reason = err instanceof Error ? err.message : "unknown-error";
    apiLogger.error(
      { err, zoomMeetingDbId: meeting.id, durationMs },
      "webinar-engagement:fetch-errored",
    );
    return { ok: false, status: "failed", reason, durationMs };
  }
}
