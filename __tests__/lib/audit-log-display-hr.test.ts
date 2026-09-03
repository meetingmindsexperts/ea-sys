/**
 * describeHrAuditAction — the readable strings for HR audit rows.
 *
 * Two properties matter more than the wording. (1) The description is built
 * only from what the HR services chose to record, so a remark or note body
 * sitting in `changes` can never surface here, however it got there. (2) A
 * shape the describer does not know falls through to the generic describer
 * instead of throwing; an audit feed that crashes on one odd row is a feed
 * nobody can read.
 */
import { describe, it, expect } from "vitest";
import {
  describeAuditAction,
  describeHrAuditAction,
  auditEntityIcon,
  auditSubjectName,
} from "@/components/activity/audit-log-display";
import { Activity } from "lucide-react";

const row = (
  entityType: string,
  action: string,
  changes: Record<string, unknown>,
  entityId = "x",
) => ({ entityType, action, entityId, changes, user: null });

describe("describeHrAuditAction", () => {
  it("returns null for a non-HR row so the generic describer takes over", () => {
    expect(describeHrAuditAction(row("Registration", "UPDATE", {}))).toBeNull();
    expect(describeAuditAction(row("Registration", "UPDATE", {}))).toBe("Registration updated");
  });

  it("Employee CREATE names the code; the subject name comes from the blob", () => {
    const r = row("Employee", "CREATE", { source: "ui", empCode: "EMP014", name: "Dina Ortiz" });
    expect(describeAuditAction(r)).toBe("Employee added (EMP014)");
    expect(auditSubjectName(r)).toBe("Dina Ortiz");
  });

  it("Employee UPDATE is a plain sentence; the changed map renders as chips elsewhere", () => {
    expect(describeAuditAction(row("Employee", "UPDATE", { changed: { status: { from: "ACTIVE", to: "RESIGNED" } } })))
      .toBe("Employee updated");
  });

  it("Attendance recorded: code, range, day count, overwritten count", () => {
    expect(
      describeAuditAction(
        row("AttendanceEntry", "UPDATE", {
          employeeId: "e1",
          code: "SL",
          from: "2026-03-12",
          to: "2026-03-14",
          days: 3,
          overwritten: [{ date: "2026-03-13", code: "P" }],
        }, "employee:e1"),
      ),
    ).toBe("Attendance recorded: SL, 12 Mar 2026 to 14 Mar 2026 (3 days), 1 overwritten");
  });

  it("a single day reads 'on <date>' with no day count", () => {
    expect(
      describeAuditAction(
        row("AttendanceEntry", "UPDATE", { code: "WFH", from: "2026-04-01", to: "2026-04-01", days: 1, overwritten: [] }),
      ),
    ).toBe("Attendance recorded: WFH, on 1 Apr 2026");
  });

  it("Attendance cleared: count + range, singular/plural", () => {
    expect(describeAuditAction(row("AttendanceEntry", "DELETE", { removed: 1, from: "2026-05-02", to: "2026-05-02" })))
      .toBe("Attendance cleared: 1 day, on 2 May 2026");
    expect(describeAuditAction(row("AttendanceEntry", "DELETE", { removed: 4, from: "2026-05-02", to: "2026-05-06" })))
      .toBe("Attendance cleared: 4 days, 2 May 2026 to 6 May 2026");
  });

  it("Standing rule: scope, code and span, open-ended when no end", () => {
    expect(
      describeAuditAction(
        row("AttendanceRule", "CREATE", { scope: "ORG", code: "WFH", startDate: "2026-03-01", endDate: "2026-03-12" }),
      ),
    ).toBe("Standing rule added: WFH, company-wide, from 1 Mar 2026 to 12 Mar 2026");
    expect(
      describeAuditAction(
        row("AttendanceRule", "DELETE", { scope: "EMPLOYEE", employeeId: "e9", code: "WFH", startDate: "2026-01-01", endDate: null }),
      ),
    ).toBe("Standing rule removed: WFH, one person, from 1 Jan 2026, open-ended");
  });

  it("a rule DELETE with a null snapshot says only that a rule was removed", () => {
    expect(
      describeAuditAction(
        row("AttendanceRule", "DELETE", { source: "ui", scope: null, employeeId: null, code: null, startDate: null, endDate: null }),
      ),
    ).toBe("Standing rule removed");
  });

  it("Leave year roll: counts, capped only when any", () => {
    expect(describeAuditAction(row("LeaveGrant", "UPDATE", { fromYear: 2026, toYear: 2027, granted: 21, skipped: 2, capped: [] }, "year:2027")))
      .toBe("Leave year 2027 carry-over: 21 granted, 2 skipped");
    expect(describeAuditAction(row("LeaveGrant", "UPDATE", { toYear: 2027, granted: 21, skipped: 0, capped: [{ empCode: "EMP001" }] })))
      .toBe("Leave year 2027 carry-over: 21 granted, 0 skipped, 1 capped");
  });

  it("Public holiday: label + date", () => {
    expect(describeAuditAction(row("PublicHoliday", "CREATE", { date: "2026-12-02", label: "National Day" })))
      .toBe("Public holiday added: National Day, 2 Dec 2026");
    expect(describeAuditAction(row("PublicHoliday", "DELETE", { date: "2026-12-03", label: "National Day" })))
      .toBe("Public holiday removed: National Day, 3 Dec 2026");
  });

  it("Attendance export (written by recordExport): row count, no filters echoed", () => {
    expect(describeAuditAction(row("HrAttendance", "EXPORT", { rowCount: 943, filters: { from: "2026-01-01", to: "2026-12-31" } })))
      .toBe("Attendance exported (943 rows)");
    expect(describeAuditAction(row("HrAttendance", "EXPORT", { rowCount: 1 })))
      .toBe("Attendance exported (1 row)");
    expect(describeAuditAction(row("HrAttendance", "EXPORT", {})))
      .toBe("Attendance exported");
  });

  it("never quotes free text, even if a remark sits in the blob", () => {
    const remark = "migraine, see doctor note";
    const r = row("AttendanceEntry", "UPDATE", {
      code: "SL", from: "2026-03-12", to: "2026-03-12", days: 1, overwritten: [], remark, notes: remark,
    });
    expect(describeAuditAction(r)).not.toContain(remark);
    expect(describeAuditAction(r)).not.toContain("migraine");
  });

  it("dates that are not YYYY-MM-DD are shown as-is rather than parsed", () => {
    expect(describeAuditAction(row("PublicHoliday", "CREATE", { date: "sometime", label: "X" })))
      .toBe("Public holiday added: X, sometime");
  });

  it("an unknown HR action falls through to the generic form, not a crash", () => {
    expect(describeAuditAction(row("Employee", "BULK_UPDATE", {}))).toBe("Bulk update on Employee");
  });

  it("every HR entity type gets a specific icon", () => {
    for (const t of ["Employee", "AttendanceEntry", "AttendanceRule", "LeaveGrant", "PublicHoliday", "HrAttendance"]) {
      expect(auditEntityIcon(t)).not.toBe(Activity);
    }
  });
});
