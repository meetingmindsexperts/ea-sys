/**
 * Event data export: one ZIP of CSVs for a whole event (Sep 30, 2026; owner:
 * "build one under event setup that says export data").
 *
 * TWO SOURCES, ONE RULE (no second copy of any column list):
 *  - Areas that already had an export (registrations, abstracts, proposals,
 *    invoices, survey, webinar attendance, reimbursements, travel grants, RSVP
 *    lists) are produced by CALLING THAT EXPORT'S ROUTE HANDLER in-process, as
 *    the same signed-in user. The file is byte-identical to the per-page
 *    button, and each area keeps its own permission check, rate limit and
 *    audit row: a user who may not export invoices gets no invoices file here
 *    either, and the README says so.
 *  - Areas with no export of their own come from sheets.ts.
 *
 * Each part is isolated: one failing area is listed in README.txt with its
 * reason and never takes the others down. Uploaded files (photos, documents,
 * certificates' PDFs) are NOT included; the README says where they live.
 */
import JSZip from "jszip";
import { db } from "@/lib/db";
import type { Principal } from "@/lib/permissions/can";
import { apiLogger } from "@/lib/logger";
import { GET as registrationsGET } from "@/app/api/events/[eventId]/registrations/route";
import { GET as abstractsGET } from "@/app/api/events/[eventId]/abstracts/route";
import { GET as proposalsGET } from "@/app/api/events/[eventId]/session-proposals/route";
import { GET as invoicesExportGET } from "@/app/api/events/[eventId]/invoices/export/route";
import { GET as surveyExportGET } from "@/app/api/events/[eventId]/survey/responses/export/route";
import { GET as webinarAttendanceGET } from "@/app/api/events/[eventId]/webinar/attendance/route";
import { GET as reimbursementsGET } from "@/app/api/events/[eventId]/reimbursements/route";
import { GET as travelGrantsGET } from "@/app/api/events/[eventId]/travel-grants/route";
import { GET as rsvpInvitesGET } from "@/app/api/events/[eventId]/rsvp-campaigns/[campaignId]/invites/route";
import {
  accommodationSheets,
  eventSheet,
  promoCodesSheet,
  registrationTypesSheet,
  sessionSheets,
  speakersSheet,
  sponsorsSheet,
  type Sheet,
} from "./sheets";

/** An area produced by an existing export route. */
interface Delegated {
  file: string;
  label: string;
  /** Path + query appended to /api/events/<id>/ */
  path: string;
  /** Calls the route's own handler with its own params. */
  call: (req: Request) => Promise<Response>;
}

export interface PartResult {
  file: string;
  label: string;
  rows: number | null;
  /** Why it is not in the ZIP; null when it is. */
  skipped: string | null;
}

export interface BundleResult {
  zip: Buffer;
  filename: string;
  parts: PartResult[];
  totalRows: number;
}

/**
 * Records in a CSV, quote-aware (a multi-paragraph abstract is one record).
 * The header is not counted.
 */
export function countCsvRecords(csv: string): number {
  let records = 0;
  let inQuotes = false;
  let sawContent = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (c === "\n" || c === "\r")) {
      if (c === "\r" && csv[i + 1] === "\n") i++;
      if (sawContent) records++;
      sawContent = false;
      continue;
    }
    sawContent = true;
  }
  if (sawContent) records++;
  return Math.max(0, records - 1);
}

/** Turn a refused response into the sentence the README shows. */
async function reasonFor(res: Response): Promise<string> {
  let message = "";
  try {
    const body = (await res.clone().json()) as { error?: string };
    message = body.error ?? "";
  } catch {
    // Not JSON: the status alone is the reason; nothing further to log.
    message = "";
  }
  if (res.status === 403) return "Not included: your role may not export this.";
  if (res.status === 404) return `Not included: ${(message || "nothing to export for this event").replace(/\.+$/, "")}.`;
  if (res.status === 429) return "Not included: the export limit for this area was reached; try again later.";
  return `Not included: ${(message || `the export failed (${res.status})`).replace(/\.+$/, "")}.`;
}

async function runDelegated(part: Delegated, eventId: string, origin: Request): Promise<{ result: PartResult; csv?: string }> {
  const url = new URL(`/api/events/${eventId}/${part.path}`, origin.url);
  // The original headers ride along, so the inner handler sees the same
  // caller (IP and user agent for its own audit row, the org header).
  const req = new Request(url, { headers: origin.headers });
  try {
    const res = await part.call(req);
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok || !type.includes("text/csv")) {
      const reason = res.ok ? "Not included: the export did not return a spreadsheet." : await reasonFor(res);
      apiLogger.warn({ msg: "event-export:part-skipped", eventId, file: part.file, status: res.status, reason });
      return { result: { file: part.file, label: part.label, rows: null, skipped: reason } };
    }
    const csv = await res.text();
    return { result: { file: part.file, label: part.label, rows: countCsvRecords(csv), skipped: null }, csv };
  } catch (err) {
    apiLogger.error({ err, msg: "event-export:part-failed", eventId, file: part.file });
    return { result: { file: part.file, label: part.label, rows: null, skipped: "Not included: this area failed to export. The rest of the file is complete." } };
  }
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "rsvp";
}

export async function buildEventBundle(args: {
  req: Request;
  eventId: string;
  /** The exporter: each sheet shows money and honorarium as their keys allow. */
  principal: Principal;
  userName: string;
}): Promise<BundleResult> {
  const { req, eventId, principal } = args;
  const event = await db.event.findFirstOrThrow({ where: { id: eventId }, select: { name: true, slug: true, eventType: true } });
  const campaigns = await db.rsvpCampaign.findMany({ where: { eventId }, select: { id: true, name: true }, orderBy: { sortOrder: "asc" } });

  const ev = { params: Promise.resolve({ eventId }) };
  const delegated: Delegated[] = [
    { file: "registrations.csv", label: "Registrations", path: "registrations?export=csv", call: (r) => registrationsGET(r, ev) },
    { file: "abstracts.csv", label: "Abstracts", path: "abstracts?export=csv", call: (r) => abstractsGET(r, ev) },
    { file: "session-proposals.csv", label: "Session proposals", path: "session-proposals?export=csv", call: (r) => proposalsGET(r, ev) },
    { file: "invoices.csv", label: "Invoices", path: "invoices/export?format=csv", call: (r) => invoicesExportGET(r, ev) },
    { file: "survey-responses.csv", label: "Survey responses", path: "survey/responses/export", call: (r) => surveyExportGET(r, ev) },
    { file: "reimbursements.csv", label: "Reimbursements", path: "reimbursements?export=csv", call: (r) => reimbursementsGET(r, ev) },
    { file: "travel-grants.csv", label: "Travel grants", path: "travel-grants?export=csv", call: (r) => travelGrantsGET(r, ev) },
    ...(event.eventType === "CONFERENCE"
      ? []
      : [{ file: "webinar-attendance.csv", label: "Webinar attendance", path: "webinar/attendance?export=csv", call: (r: Request) => webinarAttendanceGET(r, ev) }]),
    ...campaigns.map((c, i) => ({
      file: `rsvp/${String(i + 1).padStart(2, "0")}-${slugify(c.name)}.csv`,
      label: `RSVP: ${c.name}`,
      path: `rsvp-campaigns/${c.id}/invites?export=csv`,
      call: (r: Request) => rsvpInvitesGET(r, { params: Promise.resolve({ eventId, campaignId: c.id }) }),
    })),
  ];

  const zip = new JSZip();
  const parts: PartResult[] = [];

  // Own sheets first (fast, local), each isolated like the delegated ones.
  const own: { label: string; build: () => Promise<Sheet | Sheet[]> }[] = [
    { label: "Event details", build: () => eventSheet(eventId, principal) },
    { label: "Registration types and pricing tiers", build: () => registrationTypesSheet(eventId, principal) },
    { label: "Speakers", build: () => speakersSheet(eventId, principal) },
    { label: "Sessions and topics", build: () => sessionSheets(eventId) },
    { label: "Accommodation, hotels and rooms", build: () => accommodationSheets(eventId, principal) },
    { label: "Promo codes", build: () => promoCodesSheet(eventId, principal) },
    { label: "Sponsors", build: () => sponsorsSheet(eventId) },
  ];
  for (const o of own) {
    try {
      const built = await o.build();
      for (const s of Array.isArray(built) ? built : [built]) {
        zip.file(s.file, s.csv);
        parts.push({ file: s.file, label: o.label, rows: s.rows, skipped: null });
      }
    } catch (err) {
      apiLogger.error({ err, msg: "event-export:sheet-failed", eventId, label: o.label });
      parts.push({ file: "", label: o.label, rows: null, skipped: "Not included: this area failed to export. The rest of the file is complete." });
    }
  }

  // Delegated one at a time: they share the database with a live event.
  for (const d of delegated) {
    const { result, csv } = await runDelegated(d, eventId, req);
    if (csv !== undefined) zip.file(d.file, csv);
    parts.push(result);
  }

  const totalRows = parts.reduce((n, p) => n + (p.rows ?? 0), 0);
  const generatedAt = new Date();
  zip.file("README.txt", readme({ eventName: event.name, generatedAt, by: args.userName, parts }));

  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
  const stamp = generatedAt.toISOString().slice(0, 10);
  return { zip: buffer, filename: `${event.slug}-data-${stamp}.zip`, parts, totalRows };
}

function readme(a: { eventName: string; generatedAt: Date; by: string; parts: PartResult[] }): string {
  const included = a.parts.filter((p) => !p.skipped);
  const skipped = a.parts.filter((p) => p.skipped);
  const lines = [
    `${a.eventName}: data export`,
    `Generated ${a.generatedAt.toISOString()} by ${a.by}.`,
    "",
    "Each file is a CSV (UTF-8, comma-separated) that opens in Excel, Numbers or Google Sheets.",
    "Dates and times are in UTC (ISO 8601).",
    "",
    "INCLUDED",
    ...included.map((p) => `  ${p.file.padEnd(40)} ${String(p.rows ?? 0).padStart(6)} ${p.rows === 1 ? "row " : "rows"}   ${p.label}`),
    "",
  ];
  if (skipped.length) {
    lines.push("NOT INCLUDED", ...skipped.map((p) => `  ${p.label}: ${p.skipped}`), "");
  }
  lines.push(
    "NOT IN THIS FILE BY DESIGN",
    "  Uploaded files (photos, supporting documents, banners, certificate PDFs) are stored",
    "  separately. Certificates can be downloaded per issue run on the Certificates page.",
    "  Emails sent are listed on each person's Email History, not here.",
    "",
    "This file contains personal data. Store and share it accordingly.",
  );
  return lines.join("\n") + "\n";
}
