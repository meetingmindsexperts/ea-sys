/**
 * The post-event report's Word and CSV files (Nov 25, 2026): the same report as the PDF, the same
 * rules (comments only when asked, no attendee named), read back the way the client opens them.
 */
import { describe, it, expect } from "vitest";
import PizZip from "pizzip";
import type { PostEventReport } from "@/lib/webinar/post-event-report";
import { generatePostEventReportDocx } from "@/lib/webinar/post-event-report-docx";
import { postEventReportCsv, POST_EVENT_REPORT_CSV_HEADER } from "@/lib/webinar/post-event-report-csv";

const at = (min: number) => new Date(Date.UTC(2026, 10, 24, 16, min));

function report(over: Partial<PostEventReport> = {}): PostEventReport {
  return {
    generatedAt: at(90).toISOString(),
    event: { id: "ev1", name: "Improving Outcomes in β-Thalassemia", timezone: "Asia/Dubai", startTime: at(0).toISOString(), endTime: at(60).toISOString(), status: "ended" },
    registrations: { registered: 13, confirmed: 10, pending: 3, cancelled: 4, byType: [{ label: "Delegate", count: 13 }] },
    attendance: { source: "page", attended: 5, attendanceRate: 50, avgWatchSeconds: 1830, totalWatchSeconds: 9150, peak: 4, peakAt: at(20).toISOString(), devices: [{ label: "Phone", count: 3 }], archived: false },
    questions: { asked: 2, answered: 1, items: [{ question: "=HYPERLINK(\"x\") ما الجرعة؟ 💊", answered: true, votes: 2, source: "page" }, { question: "Second\u000Bline", answered: false, votes: 0, source: "zoom" }] },
    surveys: [
      {
        name: "CME survey",
        responses: 2,
        questions: [
          { type: "rating", label: "Overall", count: 2, mean: 4.5, distribution: [0, 0, 0, 1, 1] },
          { type: "choice", label: "Useful?", count: 2, options: [{ label: "Yes", count: 2 }] },
          { type: "text", label: "Comments", count: 1, comments: ["Great, \"really\" useful"] },
        ],
      },
    ],
    commentsIncluded: true,
    ...over,
  };
}

const COMPANY = { name: "MM Group", companyName: "Meeting Minds", address: null, city: null, zipCode: null, country: null, logoPath: null };

function documentXml(buffer: Buffer): string {
  const file = new PizZip(buffer).file("word/document.xml");
  if (!file) throw new Error("word/document.xml missing");
  return file.asText();
}

describe("the Word copy", () => {
  it("is a real .docx with every section, the breakdowns as tables, and typed text intact", async () => {
    const xml = documentXml(await generatePostEventReportDocx(report(), COMPANY));
    for (const text of ["Meeting Minds", "Improving Outcomes in β-Thalassemia", "Post-event report", "At a glance", "Registrations", "Attendance", "Watched on", "Questions", "Survey results", "CME survey: 2 responses", "Average 4.5 out of 5 (2 answers)"]) {
      expect(xml).toContain(text);
    }
    expect(xml).toContain("<w:tbl>");
    expect(xml).toContain("ما الجرعة؟ 💊");
    expect(xml).toContain("Great, &quot;really&quot; useful");
    // A pasted vertical tab must not reach the XML, or Word refuses the file.
    expect(xml).not.toContain("\u000B");
  });

  it("leaves comments out when not asked, saying so", async () => {
    const xml = documentXml(await generatePostEventReportDocx(report({ commentsIncluded: false }), COMPANY));
    expect(xml).not.toContain("really");
    expect(xml).toContain("1 comment, left out of this copy.");
  });

  it("names the organisation as the author, never docx's \"Un-named\"", async () => {
    const core = new PizZip(await generatePostEventReportDocx(report(), COMPANY)).file("docProps/core.xml")?.asText() ?? "";
    expect(core).toContain("<dc:creator>Meeting Minds</dc:creator>");
    expect(core).not.toContain("Un-named");
  });

  it("an archived webinar's tiles say Not known, not 0", async () => {
    const xml = documentXml(await generatePostEventReportDocx(report({ attendance: { ...report().attendance, archived: true } }), COMPANY));
    expect(xml).toContain("Not known");
  });

  it("no survey section for a caller who may not read surveys", async () => {
    const xml = documentXml(await generatePostEventReportDocx(report({ surveys: null }), COMPANY));
    expect(xml).not.toContain("Survey results");
  });
});

describe("the CSV", () => {
  const lines = (csv: string) => csv.split("\r\n").filter(Boolean);

  it("starts with a byte order mark and one header, five columns throughout", () => {
    const csv = postEventReportCsv(report());
    expect(csv.startsWith("﻿")).toBe(true);
    const rows = lines(csv.slice(1));
    expect(rows[0]).toBe(POST_EVENT_REPORT_CSV_HEADER.join(","));
    expect(rows.filter((r) => r.startsWith("Section,"))).toHaveLength(1);
  });

  it("carries the figures as numbers, minutes watched included", () => {
    const csv = postEventReportCsv(report());
    expect(csv).toContain("Registrations,Registered,,13,");
    expect(csv).toContain("Registrations by type,Delegate,,13,100");
    expect(csv).toContain("Attendance,Attended (share of confirmed registrations),,5,50");
    expect(csv).toContain("Attendance,Average watched (minutes),,30.5,");
    expect(csv).toContain("Watched on,Phone,,3,60");
    expect(csv).toContain("Survey: CME survey,Overall,Average (out of 5),4.5,");
    expect(csv).toContain("Survey: CME survey,Overall,5 stars,1,50");
    expect(csv).toContain("Survey: CME survey,Useful?,Yes,2,100");
  });

  it("an attendee's question can never run as a formula, and quotes survive", () => {
    const csv = postEventReportCsv(report());
    expect(csv).toContain(`"'=HYPERLINK(""x"") ما الجرعة؟ 💊",Answered,2,`);
    expect(csv).toContain(`"Not answered, asked in Zoom",0,`);
    expect(csv).toContain(`"Great, ""really"" useful"`);
  });

  it("a text question with no comment to show says so; no answers yet is said; no surveys for the caller says nothing", () => {
    const empty = report({
      surveys: [{ name: "S", responses: 1, questions: [{ type: "text", label: "Comments", count: 0, comments: [] }] }],
    });
    expect(postEventReportCsv(empty)).toContain("Survey: S,Comments,No comments.,0,");
    expect(postEventReportCsv(report({ surveys: [] }))).toContain("Survey results,Note,No survey answers yet.,,");
    expect(postEventReportCsv(report({ surveys: null }))).not.toContain("Survey");
  });

  it("leaves comments out when not asked, and the archived note replaces the minutes", () => {
    const csv = postEventReportCsv(report({ commentsIncluded: false, attendance: { ...report().attendance, archived: true } }));
    expect(csv).not.toContain("really");
    expect(csv).toContain("1 comment, left out of this copy.");
    expect(csv).not.toContain("Average watched");
    expect(csv).toContain("minute-by-minute record has been archived");
  });
});
