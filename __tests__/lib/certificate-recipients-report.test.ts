/**
 * The certificate recipients report (src/lib/certificates/recipients-report.ts,
 * Nov 11, 2026): the one state each assigned person is in, and the export.
 * The loader is proven against a real Postgres in
 * tests/integration-db/certificate-assignments.db.test.ts.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import {
  RECIPIENT_REPORT_HEADERS,
  RECIPIENT_STATES,
  RECIPIENT_STATE_HINTS,
  RECIPIENT_STATE_LABELS,
  certificatesByRegistration,
  recipientReportCsv,
  recipientState,
  type RecipientReport,
  type RecipientStateFacts,
} from "@/lib/certificates/recipients-report";

const base: RecipientStateFacts = {
  registrationCancelled: false,
  certificate: null,
  autoIssueOnSurvey: true,
  surveyAnswered: false,
  sweepChecked: false,
  sweepFailed: false,
  inRun: false,
};
const state = (over: Partial<RecipientStateFacts>) => recipientState({ ...base, ...over });

describe("recipientState", () => {
  it("a certificate that exists speaks first", () => {
    expect(state({ certificate: { revoked: false, released: true } })).toBe("SENT");
    expect(state({ certificate: { revoked: false, released: false } })).toBe("ISSUED_NOT_SENT");
    expect(state({ certificate: { revoked: true, released: true } })).toBe("REVOKED");
    // Even for a registration cancelled afterwards: the certificate went out.
    expect(state({ certificate: { revoked: false, released: true }, registrationCancelled: true })).toBe("SENT");
  });

  it("a cancelled registration with no certificate never gets one, whatever else is true", () => {
    expect(state({ registrationCancelled: true, surveyAnswered: true, inRun: true })).toBe("CANCELLED");
  });

  it("a run in flight is about to send it, with or without the switch", () => {
    expect(state({ inRun: true })).toBe("SENDING");
    expect(state({ inRun: true, autoIssueOnSurvey: false })).toBe("SENDING");
  });

  it("without the switch, nothing sends it on its own: it waits for Issue whether or not they answered", () => {
    expect(state({ autoIssueOnSurvey: false })).toBe("READY");
    expect(state({ autoIssueOnSurvey: false, surveyAnswered: true, sweepChecked: true })).toBe("READY");
  });

  it("with the switch: waiting for the survey, then for the next sweep", () => {
    expect(state({})).toBe("WAITING_FOR_SURVEY");
    expect(state({ surveyAnswered: true })).toBe("SENDING");
  });

  it("answered, looked at and nothing sent: the sweep will not come back, so it needs Issue", () => {
    expect(state({ surveyAnswered: true, sweepChecked: true })).toBe("READY");
  });

  it("the sweep giving up shows as could not send", () => {
    expect(state({ surveyAnswered: true, sweepChecked: true, sweepFailed: true })).toBe("FAILED");
  });

  it("every state has a label and a hint, and they are all different", () => {
    for (const s of RECIPIENT_STATES) {
      expect(RECIPIENT_STATE_LABELS[s]).toBeTruthy();
      expect(RECIPIENT_STATE_HINTS[s]).toBeTruthy();
    }
    expect(new Set(Object.values(RECIPIENT_STATE_LABELS)).size).toBe(RECIPIENT_STATES.length);
  });
});

describe("recipientReportCsv", () => {
  const report: RecipientReport = {
    timezone: "Asia/Dubai",
    templates: [],
    answeredNotAssigned: [],
    rows: [
      {
        assignmentId: "a1",
        templateId: "t1",
        templateName: "CME",
        category: "ATTENDANCE",
        kind: "registration",
        registrationId: "r1",
        speakerId: null,
        name: "Dr. Jane Doe",
        email: "jane@x.com",
        registrationType: "Physician",
        source: "EMAIL_LIST",
        // 21:30 UTC on the 1st is the 2nd in Dubai: the export shows the event's day.
        assignedAt: new Date("2026-11-01T21:30:00Z"),
        assignedByName: "Ada Admin",
        surveyAnsweredAt: new Date("2026-11-02T08:00:00Z"),
        state: "SENT",
        cmeHours: "6",
        certificate: { id: "c1", serial: "EVT-ATT-0001", issuedAt: new Date("2026-11-02T08:05:00Z") },
      },
      {
        assignmentId: "a2",
        templateId: "t2",
        templateName: "Speaker",
        category: "APPRECIATION",
        kind: "speaker",
        registrationId: null,
        speakerId: "s1",
        name: "Sam Lee",
        email: null,
        registrationType: null,
        source: "TAG_BACKFILL",
        assignedAt: new Date("2026-11-01T06:00:00Z"),
        assignedByName: null,
        surveyAnsweredAt: null,
        state: "WAITING_FOR_SURVEY",
        cmeHours: null,
        certificate: null,
      },
    ],
  };

  it("writes the header and one line per assigned person per certificate", () => {
    const csv = recipientReportCsv(report);
    expect(csv[0]).toEqual([...RECIPIENT_REPORT_HEADERS]);
    expect(csv).toHaveLength(3);
    expect(csv.every((line) => line.length === RECIPIENT_REPORT_HEADERS.length)).toBe(true);
  });

  it("uses plain words and the event's own days", () => {
    const [, sent, waiting] = recipientReportCsv(report);
    expect(sent).toEqual([
      "CME", "Attendance", "Dr. Jane Doe", "jane@x.com", "Physician", "Sent",
      "2026-11-02", "EVT-ATT-0001", "2026-11-02", "6", "2026-11-02", "Ada Admin", "From a list of emails",
    ]);
    expect(waiting).toEqual([
      "Speaker", "Appreciation", "Sam Lee", "", "", "Waiting for survey",
      "", "", "", "", "2026-11-01", "", "Carried over from a tag",
    ]);
  });
});

describe("certificatesByRegistration (the Registrations export's two columns, Nov 12, 2026)", () => {
  const line = (over: Partial<RecipientReport["rows"][number]>): RecipientReport["rows"][number] => ({
    assignmentId: "a",
    templateId: "t1",
    templateName: "CME",
    category: "ATTENDANCE",
    kind: "registration",
    registrationId: "r1",
    speakerId: null,
    name: "Jane Doe",
    email: "jane@x.com",
    registrationType: "Physician",
    source: "MANUAL",
    assignedAt: new Date("2026-11-01T06:00:00Z"),
    assignedByName: null,
    surveyAnsweredAt: null,
    state: "READY",
    cmeHours: null,
    certificate: null,
    ...over,
  });
  const template = (id: string, name: string): RecipientReport["templates"][number] => ({
    id,
    name,
    category: "ATTENDANCE",
    autoIssueOnSurvey: false,
    assigned: 0,
    counts: Object.fromEntries(RECIPIENT_STATES.map((s) => [s, 0])) as RecipientReport["templates"][number]["counts"],
  });
  const reportOf = (rows: RecipientReport["rows"]): RecipientReport => ({
    timezone: "Asia/Dubai",
    templates: [template("t1", "CME"), template("t2", "Workshop")],
    answeredNotAssigned: [],
    rows,
  });

  it("gives each registration what it is assigned, with the report's own state", () => {
    const map = certificatesByRegistration(
      reportOf([line({ state: "SENT" }), line({ assignmentId: "b", registrationId: "r2", state: "WAITING_FOR_SURVEY" })]),
    );
    expect(map.get("r1")).toEqual([{ templateName: "CME", state: "SENT" }]);
    expect(map.get("r2")).toEqual([{ templateName: "CME", state: "WAITING_FOR_SURVEY" }]);
    expect(map.has("r3")).toBe(false);
  });

  it("lists two certificates in the page's template order, whichever was assigned first", () => {
    const map = certificatesByRegistration(
      reportOf([
        line({ assignmentId: "w", templateId: "t2", templateName: "Workshop", state: "READY" }),
        line({ assignmentId: "c", state: "SENT" }),
      ]),
    );
    expect(map.get("r1")).toEqual([
      { templateName: "CME", state: "SENT" },
      { templateName: "Workshop", state: "READY" },
    ]);
  });

  it("leaves a speaker's certificate out: it belongs to the speaker record, not to a registration", () => {
    const map = certificatesByRegistration(
      reportOf([line({ kind: "speaker", registrationId: null, speakerId: "s1", category: "APPRECIATION" })]),
    );
    expect(map.size).toBe(0);
  });
});
