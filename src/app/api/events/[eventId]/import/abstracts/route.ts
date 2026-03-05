import { NextResponse } from "next/server";
import crypto from "crypto";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { checkRateLimit } from "@/lib/security";
import { parseCSV, getField } from "@/lib/csv-parser";

const ABSTRACT_STATUS_VALUES = new Set([
  "DRAFT", "SUBMITTED", "UNDER_REVIEW", "ACCEPTED", "REJECTED", "REVISION_REQUESTED",
]);

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [{ eventId }, session] = await Promise.all([params, auth()]);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const rateLimit = checkRateLimit({
      key: `import-abstracts:org:${session.user.organizationId}`,
      limit: 10,
      windowMs: 60 * 60 * 1000,
    });
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { error: "Import limit reached. Maximum 10 imports per hour." },
        { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } }
      );
    }

    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    const text = await file.text();
    const { headers, rows, error: parseError } = parseCSV(text);
    if (parseError) {
      return NextResponse.json({ error: parseError }, { status: 400 });
    }

    const idx = {
      title: headers.indexOf("title"),
      content: headers.indexOf("content"),
      speakerEmail: headers.indexOf("speakeremail"),
      specialty: headers.indexOf("specialty"),
      track: headers.indexOf("track"),
      status: headers.indexOf("status"),
    };

    if (idx.title === -1 || idx.content === -1 || idx.speakerEmail === -1) {
      return NextResponse.json(
        { error: "CSV must have title, content, and speakerEmail columns" },
        { status: 400 }
      );
    }

    // Verify event
    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: session.user.organizationId! },
      select: { id: true },
    });
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    // Load speakers and tracks
    const [existingSpeakers, existingTracks] = await Promise.all([
      db.speaker.findMany({ where: { eventId }, select: { id: true, email: true } }),
      db.track.findMany({ where: { eventId }, select: { id: true, name: true } }),
    ]);

    const speakerByEmail = new Map(existingSpeakers.map((s) => [s.email.toLowerCase(), s.id]));
    const trackByName = new Map(existingTracks.map((t) => [t.name.toLowerCase(), t.id]));
    let nextSortOrder = existingTracks.length;

    apiLogger.info({ msg: "Import started", importType: "abstracts", source: "csv", eventId, userId: session.user.id, rowCount: rows.length });

    const errors: string[] = [];
    let created = 0;
    let skipped = 0;

    for (let i = 0; i < rows.length; i++) {
      const fields = rows[i];
      const rowNum = i + 2;

      const title = getField(fields, idx.title);
      const content = getField(fields, idx.content);
      const speakerEmail = getField(fields, idx.speakerEmail)?.toLowerCase();

      if (!title || !content || !speakerEmail) {
        errors.push(`Row ${rowNum}: missing required fields (title, content, speakerEmail)`);
        continue;
      }

      const speakerId = speakerByEmail.get(speakerEmail);
      if (!speakerId) {
        errors.push(`Row ${rowNum}: speaker "${speakerEmail}" not found for this event`);
        skipped++;
        continue;
      }

      // Resolve track
      let trackId: string | null = null;
      const trackName = getField(fields, idx.track);
      if (trackName) {
        const existingTrackId = trackByName.get(trackName.toLowerCase());
        if (existingTrackId) {
          trackId = existingTrackId;
        } else {
          const newTrack = await db.track.create({
            data: { eventId, name: trackName, sortOrder: nextSortOrder++ },
          });
          trackByName.set(trackName.toLowerCase(), newTrack.id);
          trackId = newTrack.id;
        }
      }

      const statusRaw = getField(fields, idx.status)?.toUpperCase();
      const status = statusRaw && ABSTRACT_STATUS_VALUES.has(statusRaw) ? statusRaw : "SUBMITTED";

      try {
        await db.abstract.create({
          data: {
            eventId,
            speakerId,
            title,
            content,
            specialty: getField(fields, idx.specialty) || null,
            trackId,
            status: status as "DRAFT" | "SUBMITTED" | "UNDER_REVIEW" | "ACCEPTED" | "REJECTED" | "REVISION_REQUESTED",
            managementToken: crypto.randomBytes(32).toString("hex"),
            submittedAt: status === "SUBMITTED" ? new Date() : undefined,
          },
        });
        created++;
      } catch (err) {
        errors.push(`Row ${rowNum}: ${err instanceof Error ? err.message : "unknown error"}`);
      }
    }

    apiLogger.info({ msg: "Import complete", importType: "abstracts", source: "csv", eventId, userId: session.user.id, created, skipped, errorCount: errors.length });
    if (errors.length > 0) {
      apiLogger.warn({ msg: "Import errors", importType: "abstracts", source: "csv", eventId, userId: session.user.id, errors: errors.slice(0, 50) });
    }

    return NextResponse.json({ created, skipped, errors });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error importing abstracts" });
    return NextResponse.json({ error: "Failed to import abstracts" }, { status: 500 });
  }
}
