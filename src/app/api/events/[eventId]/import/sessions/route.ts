import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { checkRateLimit } from "@/lib/security";
import { parseCSV, getField } from "@/lib/csv-parser";

const SESSION_STATUS_VALUES = new Set(["DRAFT", "SCHEDULED", "LIVE", "COMPLETED", "CANCELLED"]);

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
      key: `import-sessions:org:${session.user.organizationId}`,
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
      name: headers.indexOf("name"),
      startTime: headers.indexOf("starttime"),
      endTime: headers.indexOf("endtime"),
      description: headers.indexOf("description"),
      location: headers.indexOf("location"),
      capacity: headers.indexOf("capacity"),
      track: headers.indexOf("track"),
      speakerEmails: headers.indexOf("speakeremails"),
      status: headers.indexOf("status"),
    };

    if (idx.name === -1 || idx.startTime === -1 || idx.endTime === -1) {
      return NextResponse.json(
        { error: "CSV must have name, startTime, and endTime columns" },
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

    // Load existing tracks and speakers for this event
    const [existingTracks, existingSpeakers] = await Promise.all([
      db.track.findMany({ where: { eventId }, select: { id: true, name: true } }),
      db.speaker.findMany({ where: { eventId }, select: { id: true, email: true } }),
    ]);

    const trackByName = new Map(existingTracks.map((t) => [t.name.toLowerCase(), t.id]));
    const speakerByEmail = new Map(existingSpeakers.map((s) => [s.email.toLowerCase(), s.id]));

    apiLogger.info({ msg: "Import started", importType: "sessions", source: "csv", eventId, userId: session.user.id, rowCount: rows.length });

    const errors: string[] = [];
    let created = 0;
    let tracksCreated = 0;

    // Get next sort order for tracks
    let nextSortOrder = existingTracks.length;

    for (let i = 0; i < rows.length; i++) {
      const fields = rows[i];
      const rowNum = i + 2;

      const name = getField(fields, idx.name);
      const startTimeRaw = getField(fields, idx.startTime);
      const endTimeRaw = getField(fields, idx.endTime);

      if (!name || !startTimeRaw || !endTimeRaw) {
        errors.push(`Row ${rowNum}: missing required fields (name, startTime, endTime)`);
        continue;
      }

      const startTime = new Date(startTimeRaw);
      const endTime = new Date(endTimeRaw);

      if (isNaN(startTime.getTime()) || isNaN(endTime.getTime())) {
        errors.push(`Row ${rowNum}: invalid date format (use ISO 8601, e.g. 2026-03-15T09:00:00Z)`);
        continue;
      }

      if (endTime <= startTime) {
        errors.push(`Row ${rowNum}: endTime must be after startTime`);
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
          tracksCreated++;
        }
      }

      // Resolve speakers
      const speakerEmailsRaw = getField(fields, idx.speakerEmails);
      const speakerIds: string[] = [];
      if (speakerEmailsRaw) {
        const emails = speakerEmailsRaw.split(";").map((e) => e.trim().toLowerCase()).filter(Boolean);
        for (const email of emails) {
          const sid = speakerByEmail.get(email);
          if (sid) {
            speakerIds.push(sid);
          } else {
            errors.push(`Row ${rowNum}: speaker "${email}" not found for this event`);
          }
        }
      }

      const statusRaw = getField(fields, idx.status)?.toUpperCase();
      const status = statusRaw && SESSION_STATUS_VALUES.has(statusRaw) ? statusRaw : "SCHEDULED";
      const capacityRaw = getField(fields, idx.capacity);
      const capacity = capacityRaw ? parseInt(capacityRaw, 10) : null;

      try {
        await db.eventSession.create({
          data: {
            eventId,
            name,
            startTime,
            endTime,
            description: getField(fields, idx.description) || null,
            location: getField(fields, idx.location) || null,
            capacity: capacity && !isNaN(capacity) ? capacity : null,
            trackId,
            status: status as "DRAFT" | "SCHEDULED" | "LIVE" | "COMPLETED" | "CANCELLED",
            speakers: speakerIds.length > 0
              ? { create: speakerIds.map((sid) => ({ speakerId: sid })) }
              : undefined,
          },
        });
        created++;
      } catch (err) {
        errors.push(`Row ${rowNum}: ${err instanceof Error ? err.message : "unknown error"}`);
      }
    }

    apiLogger.info({ msg: "Import complete", importType: "sessions", source: "csv", eventId, userId: session.user.id, created, tracksCreated, errorCount: errors.length });
    if (errors.length > 0) {
      apiLogger.warn({ msg: "Import errors", importType: "sessions", source: "csv", eventId, userId: session.user.id, errors: errors.slice(0, 50) });
    }

    return NextResponse.json({ created, tracksCreated, errors });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error importing sessions" });
    return NextResponse.json({ error: "Failed to import sessions" }, { status: 500 });
  }
}
