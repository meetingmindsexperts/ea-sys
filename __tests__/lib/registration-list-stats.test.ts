/**
 * The Registrations page's summary card (owner report, Nov 12, 2026, on the
 * 4th GCC Hematology Hub). The card read Total 65 beside Confirmed 27, Pending
 * 37 and Checked In 0: a cancelled registration sat in the total and in Paid
 * and in no tile, and nothing said that 38 of the 65 were typed in by staff,
 * 33 of them on a hand-made type called "Faculty".
 */
import { describe, it, expect } from "vitest";
import {
  lookalikeFacultyTypes,
  paidNoteOf,
  sourceGroupOf,
  sourcesLine,
  summarizeRegistrationRows,
  totalNote,
  type RegistrationStatRow,
} from "@/lib/registration-list-stats";

const type = (id: string, name: string) => ({ id, name, isFaculty: false });
const PHYSICIAN = type("t-phys", "Physician");
const NURSE = type("t-nurse", "Nurse");
const HANDMADE = type("t-fac", "Faculty");

function rows(n: number, row: RegistrationStatRow): RegistrationStatRow[] {
  return Array.from({ length: n }, () => ({ ...row }));
}

// The event as production held it when the owner reported it.
const GCC_HUB: RegistrationStatRow[] = [
  ...rows(22, { status: "CONFIRMED", paymentStatus: "UNPAID", createdSource: "PUBLIC_REGISTER", ticketType: NURSE }),
  ...rows(4, { status: "CONFIRMED", paymentStatus: "PAID", createdSource: "PUBLIC_REGISTER", ticketType: PHYSICIAN }),
  ...rows(1, { status: "CANCELLED", paymentStatus: "PAID", createdSource: "PUBLIC_REGISTER", ticketType: NURSE }),
  ...rows(32, { status: "PENDING", paymentStatus: "UNPAID", createdSource: "ADMIN_DASHBOARD", ticketType: HANDMADE }),
  ...rows(1, { status: "CONFIRMED", paymentStatus: "COMPLIMENTARY", createdSource: "ADMIN_DASHBOARD", ticketType: HANDMADE }),
  ...rows(3, { status: "PENDING", paymentStatus: "UNPAID", createdSource: "ADMIN_DASHBOARD", ticketType: PHYSICIAN }),
  ...rows(2, { status: "PENDING", paymentStatus: "UNASSIGNED", createdSource: "ADMIN_DASHBOARD", ticketType: null }),
];

describe("summarizeRegistrationRows", () => {
  const stats = summarizeRegistrationRows(GCC_HUB);

  it("counts live registrations only, so the total is the sum of its tiles", () => {
    expect(stats.total).toBe(64);
    expect(stats.confirmed + stats.pending + stats.checkedIn + stats.waitlisted).toBe(stats.total);
    expect(stats).toMatchObject({ confirmed: 27, pending: 37, checkedIn: 0, waitlisted: 0, cancelled: 1 });
  });

  it("keeps a cancelled registration's payment out of Paid and names it apart", () => {
    expect(stats.paid).toBe(4);
    expect(stats.cancelledPaid).toBe(1);
    expect(stats.complimentary).toBe(1);
  });

  it("says where the live registrations came from, in a fixed order", () => {
    expect(stats.sources).toEqual([
      { group: "online", count: 26 },
      { group: "staff", count: 38 },
    ]);
    expect(sourcesLine(stats)).toBe("26 registered online · 38 added by staff");
  });

  it("lists the types largest first, with no type last whatever its size", () => {
    const many = summarizeRegistrationRows([
      ...rows(9, { status: "PENDING", paymentStatus: "UNASSIGNED", ticketType: null }),
      ...rows(2, { status: "CONFIRMED", paymentStatus: "PAID", ticketType: NURSE }),
      ...rows(5, { status: "CONFIRMED", paymentStatus: "PAID", ticketType: PHYSICIAN }),
    ]);
    expect(many.types.map((t) => `${t.name} ${t.count}`)).toEqual(["Physician 5", "Nurse 2", "No type yet 9"]);
  });

  it("counts a waitlisted registration in the total and names it", () => {
    const s = summarizeRegistrationRows([
      { status: "WAITLISTED", paymentStatus: "UNPAID", ticketType: NURSE },
      { status: "CHECKED_IN", paymentStatus: "PAID", ticketType: NURSE },
    ]);
    expect(s).toMatchObject({ total: 2, waitlisted: 1, checkedIn: 1, confirmed: 0 });
    expect(totalNote(s)).toBe("1 waitlisted");
  });

  it("is all zeros, with nothing to list, for no rows", () => {
    const empty = summarizeRegistrationRows([]);
    expect(empty).toMatchObject({ total: 0, confirmed: 0, pending: 0, checkedIn: 0, cancelled: 0, paid: 0, sources: [], types: [] });
    expect(sourcesLine(empty)).toBeNull();
    expect(totalNote(empty)).toBeNull();
    expect(paidNoteOf(empty)).toBeNull();
  });
});

describe("sourceGroupOf", () => {
  it("groups every door an organiser thinks in", () => {
    expect(["PUBLIC_REGISTER", "PUBLIC_SUBMITTER", "PUBLIC_COMPLETION_FORM", "GROUP_REGISTER"].map(sourceGroupOf)).toEqual(["online", "online", "online", "online"]);
    expect(["ADMIN_DASHBOARD", "FACULTY_ADMIN"].map(sourceGroupOf)).toEqual(["staff", "staff"]);
    expect(sourceGroupOf("CSV_IMPORT")).toBe("imported");
    expect(sourceGroupOf("ONSITE_DESK")).toBe("desk");
    expect(sourceGroupOf("MCP_AGENT")).toBe("agent");
    expect(sourceGroupOf("SPEAKER_COMPANION")).toBe("speakers");
  });

  it("never drops a row it cannot place: an older row, OTHER, a value added later", () => {
    expect([null, undefined, "", "OTHER", "SOMETHING_NEW"].map(sourceGroupOf)).toEqual(["unknown", "unknown", "unknown", "unknown", "unknown"]);
  });
});

describe("the notes under Total and Paid", () => {
  it("names the cancelled registrations the total leaves out", () => {
    expect(totalNote({ cancelled: 1, waitlisted: 0 })).toBe("1 cancelled, not counted");
    expect(totalNote({ cancelled: 3, waitlisted: 2 })).toBe("2 waitlisted · 3 cancelled, not counted");
  });

  it("adds a cancelled registration that is still marked paid to the free and sponsor-paid counts", () => {
    expect(paidNoteOf({ paid: 4, complimentary: 1, inclusive: 0, cancelledPaid: 1 })).toBe("1 complimentary · 1 cancelled, still marked paid");
    expect(paidNoteOf({ paid: 4, complimentary: 0, inclusive: 0, cancelledPaid: 2 })).toBe("2 cancelled, still marked paid");
    expect(paidNoteOf({ paid: 4, complimentary: 0, inclusive: 0, cancelledPaid: 0 })).toBeNull();
  });
});

describe("lookalikeFacultyTypes", () => {
  it("points at a delegate type whose name says faculty or speaker", () => {
    expect(lookalikeFacultyTypes(summarizeRegistrationRows(GCC_HUB))).toEqual([{ id: "t-fac", name: "Faculty", count: 33 }]);
    const named = (name: string) =>
      lookalikeFacultyTypes(summarizeRegistrationRows([{ status: "CONFIRMED", paymentStatus: "UNPAID", ticketType: type("x", name) }])).length;
    expect(["Speaker", "Speakers", "Invited Faculty", "Symposium Speaker ", "FACULTY"].map(named)).toEqual([1, 1, 1, 1, 1]);
  });

  it("leaves ordinary types alone, and a registration with no type", () => {
    const named = (name: string) =>
      lookalikeFacultyTypes(summarizeRegistrationRows([{ status: "CONFIRMED", paymentStatus: "UNPAID", ticketType: type("x", name) }])).length;
    expect(["Physician", "Nurse", "Loudspeaker Vendor", "Facultyless"].map(named)).toEqual([0, 0, 0, 0]);
    expect(lookalikeFacultyTypes(summarizeRegistrationRows([{ status: "PENDING", paymentStatus: "UNASSIGNED", ticketType: null }]))).toEqual([]);
  });

  it("counts only live registrations on the type", () => {
    const s = summarizeRegistrationRows([
      { status: "CANCELLED", paymentStatus: "UNPAID", ticketType: HANDMADE },
      { status: "PENDING", paymentStatus: "UNPAID", ticketType: HANDMADE },
    ]);
    expect(lookalikeFacultyTypes(s)).toEqual([{ id: "t-fac", name: "Faculty", count: 1 }]);
  });
});
