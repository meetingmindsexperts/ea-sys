/**
 * Tests for CSV import validation logic used across all import routes.
 * Tests the column detection, email validation, enum validation, and
 * data parsing patterns used in registrations, speakers, sessions, and abstracts imports.
 */
import { describe, it, expect } from "vitest";
import { parseCSV, getField, parseTags, parseCSVHeaders } from "@/lib/csv-parser";

// ── Validation patterns shared across import routes ─────────────────

const TITLE_VALUES = new Set(["MR", "MS", "MRS", "DR", "PROF", "OTHER"]);
const SPEAKER_STATUS_VALUES = new Set(["INVITED", "CONFIRMED", "DECLINED", "CANCELLED"]);
const SESSION_STATUS_VALUES = new Set(["DRAFT", "SCHEDULED", "LIVE", "COMPLETED", "CANCELLED"]);
const ABSTRACT_STATUS_VALUES = new Set([
  "DRAFT", "SUBMITTED", "UNDER_REVIEW", "ACCEPTED", "REJECTED", "REVISION_REQUESTED",
]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ── Email validation ────────────────────────────────────────────────

describe("Email validation (import routes)", () => {
  it.each([
    "user@example.com",
    "test.user@domain.co.uk",
    "name+tag@org.com",
    "first.last@sub.domain.com",
  ])("accepts valid email: %s", (email) => {
    expect(EMAIL_RE.test(email)).toBe(true);
  });

  it.each([
    "",
    "not-an-email",
    "@no-user.com",
    "no-domain@",
    "spaces in@email.com",
    "no@dots",
  ])("rejects invalid email: %s", (email) => {
    expect(EMAIL_RE.test(email)).toBe(false);
  });
});

// ── Title enum validation ───────────────────────────────────────────

describe("Title enum validation", () => {
  it.each(["MR", "MS", "MRS", "DR", "PROF", "OTHER"])(
    "accepts valid title: %s",
    (title) => {
      expect(TITLE_VALUES.has(title)).toBe(true);
    }
  );

  it("accepts case-insensitive title after toUpperCase", () => {
    expect(TITLE_VALUES.has("dr".toUpperCase())).toBe(true);
    expect(TITLE_VALUES.has("Prof".toUpperCase())).toBe(true);
  });

  it.each(["MISS", "SIR", "LADY", "REV", ""])(
    "rejects invalid title: %s",
    (title) => {
      expect(TITLE_VALUES.has(title)).toBe(false);
    }
  );
});

// ── Speaker status validation ───────────────────────────────────────

describe("Speaker status validation", () => {
  it.each(["INVITED", "CONFIRMED", "DECLINED", "CANCELLED"])(
    "accepts valid status: %s",
    (status) => {
      expect(SPEAKER_STATUS_VALUES.has(status)).toBe(true);
    }
  );

  it("defaults to INVITED for unknown status", () => {
    const statusRaw = "UNKNOWN";
    const status = SPEAKER_STATUS_VALUES.has(statusRaw) ? statusRaw : "INVITED";
    expect(status).toBe("INVITED");
  });

  it("defaults to INVITED for undefined status", () => {
    const statusRaw = undefined;
    const status = statusRaw && SPEAKER_STATUS_VALUES.has(statusRaw) ? statusRaw : "INVITED";
    expect(status).toBe("INVITED");
  });
});

// ── Session status validation ───────────────────────────────────────

describe("Session status validation", () => {
  it.each(["DRAFT", "SCHEDULED", "LIVE", "COMPLETED", "CANCELLED"])(
    "accepts valid status: %s",
    (status) => {
      expect(SESSION_STATUS_VALUES.has(status)).toBe(true);
    }
  );

  it("defaults to SCHEDULED for unknown status", () => {
    const statusRaw = "ACTIVE";
    const status = SESSION_STATUS_VALUES.has(statusRaw) ? statusRaw : "SCHEDULED";
    expect(status).toBe("SCHEDULED");
  });
});

// ── Abstract status validation ──────────────────────────────────────

describe("Abstract status validation", () => {
  it.each([
    "DRAFT",
    "SUBMITTED",
    "UNDER_REVIEW",
    "ACCEPTED",
    "REJECTED",
    "REVISION_REQUESTED",
  ])("accepts valid status: %s", (status) => {
    expect(ABSTRACT_STATUS_VALUES.has(status)).toBe(true);
  });

  it("defaults to SUBMITTED for unknown status", () => {
    const statusRaw = "PENDING";
    const status = ABSTRACT_STATUS_VALUES.has(statusRaw) ? statusRaw : "SUBMITTED";
    expect(status).toBe("SUBMITTED");
  });
});

// ── Registration CSV column detection ───────────────────────────────

describe("Registration CSV column detection", () => {
  it("detects required columns (email, firstName, lastName)", () => {
    const csv = "email,firstName,lastName\njohn@test.com,John,Doe";
    const { headers } = parseCSV(csv);

    expect(headers.indexOf("email")).toBe(0);
    expect(headers.indexOf("firstname")).toBe(1);
    expect(headers.indexOf("lastname")).toBe(2);
  });

  it("detects case-insensitive columns", () => {
    const headers = parseCSVHeaders("Email,FirstName,LastName,Organization,JobTitle");
    expect(headers.indexOf("email")).toBe(0);
    expect(headers.indexOf("firstname")).toBe(1);
    expect(headers.indexOf("organization")).toBe(3);
    expect(headers.indexOf("jobtitle")).toBe(4);
  });

  it("reports missing required columns", () => {
    const csv = "name,organization\nJohn,Acme";
    const { headers } = parseCSV(csv);

    const idx = {
      email: headers.indexOf("email"),
      firstName: headers.indexOf("firstname"),
      lastName: headers.indexOf("lastname"),
    };

    expect(idx.email).toBe(-1);
    expect(idx.firstName).toBe(-1);
    expect(idx.lastName).toBe(-1);
  });

  it("handles all optional registration columns", () => {
    const csv =
      "email,firstName,lastName,organization,jobTitle,phone,city,country,specialty,registrationType,tags,dietaryReqs,notes,title\njohn@test.com,John,Doe,Acme,CTO,555,Dubai,UAE,AI,VIP,\"tag1,tag2\",Vegan,Notes,Dr";
    const { headers, rows } = parseCSV(csv);

    expect(headers).toContain("organization");
    expect(headers).toContain("jobtitle");
    expect(headers).toContain("phone");
    expect(headers).toContain("city");
    expect(headers).toContain("country");
    expect(headers).toContain("specialty");
    expect(headers).toContain("registrationtype");
    expect(headers).toContain("tags");
    expect(headers).toContain("dietaryreqs");
    expect(headers).toContain("notes");
    expect(headers).toContain("title");
    expect(rows).toHaveLength(1);
  });
});

// ── Speaker CSV column detection ────────────────────────────────────

describe("Speaker CSV column detection", () => {
  it("detects required columns", () => {
    const headers = parseCSVHeaders("email,firstName,lastName,bio,status");
    expect(headers.indexOf("email")).toBe(0);
    expect(headers.indexOf("firstname")).toBe(1);
    expect(headers.indexOf("lastname")).toBe(2);
    expect(headers.indexOf("bio")).toBe(3);
    expect(headers.indexOf("status")).toBe(4);
  });

  it("supports website and specialty optional columns", () => {
    const headers = parseCSVHeaders(
      "email,firstName,lastName,website,specialty,registrationType"
    );
    expect(headers.indexOf("website")).toBe(3);
    expect(headers.indexOf("specialty")).toBe(4);
    expect(headers.indexOf("registrationtype")).toBe(5);
  });
});

// ── Session CSV column detection ────────────────────────────────────

describe("Session CSV column detection", () => {
  it("detects required columns (name, startTime, endTime)", () => {
    const headers = parseCSVHeaders("name,startTime,endTime");
    expect(headers.indexOf("name")).toBe(0);
    expect(headers.indexOf("starttime")).toBe(1);
    expect(headers.indexOf("endtime")).toBe(2);
  });

  it("detects optional columns including speakerEmails", () => {
    const headers = parseCSVHeaders(
      "name,startTime,endTime,description,location,capacity,track,speakerEmails,status"
    );
    expect(headers.indexOf("description")).toBe(3);
    expect(headers.indexOf("location")).toBe(4);
    expect(headers.indexOf("capacity")).toBe(5);
    expect(headers.indexOf("track")).toBe(6);
    expect(headers.indexOf("speakeremails")).toBe(7);
    expect(headers.indexOf("status")).toBe(8);
  });
});

// ── Abstract CSV column detection ───────────────────────────────────

describe("Abstract CSV column detection", () => {
  it("detects required columns (title, content, speakerEmail)", () => {
    const headers = parseCSVHeaders("title,content,speakerEmail");
    expect(headers.indexOf("title")).toBe(0);
    expect(headers.indexOf("content")).toBe(1);
    expect(headers.indexOf("speakeremail")).toBe(2);
  });

  it("detects optional columns", () => {
    const headers = parseCSVHeaders(
      "title,content,speakerEmail,specialty,track,status"
    );
    expect(headers.indexOf("specialty")).toBe(3);
    expect(headers.indexOf("track")).toBe(4);
    expect(headers.indexOf("status")).toBe(5);
  });
});

// ── Session date validation ─────────────────────────────────────────

describe("Session date validation", () => {
  it("parses valid ISO 8601 dates", () => {
    const start = new Date("2026-03-15T09:00:00Z");
    const end = new Date("2026-03-15T10:00:00Z");

    expect(isNaN(start.getTime())).toBe(false);
    expect(isNaN(end.getTime())).toBe(false);
    expect(end > start).toBe(true);
  });

  it("rejects invalid date strings", () => {
    expect(isNaN(new Date("not-a-date").getTime())).toBe(true);
    expect(isNaN(new Date("").getTime())).toBe(true);
  });

  it("detects endTime before startTime", () => {
    const start = new Date("2026-03-15T10:00:00Z");
    const end = new Date("2026-03-15T09:00:00Z");

    expect(end <= start).toBe(true);
  });

  it("detects equal start and end times", () => {
    const start = new Date("2026-03-15T09:00:00Z");
    const end = new Date("2026-03-15T09:00:00Z");

    expect(end <= start).toBe(true);
  });
});

// ── Speaker email parsing (semicolon-separated) ─────────────────────

describe("Speaker email parsing (sessions import)", () => {
  it("splits semicolon-separated emails", () => {
    const raw = "speaker1@test.com;speaker2@test.com;speaker3@test.com";
    const emails = raw
      .split(";")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);

    expect(emails).toEqual([
      "speaker1@test.com",
      "speaker2@test.com",
      "speaker3@test.com",
    ]);
  });

  it("handles whitespace around semicolons", () => {
    const raw = "a@test.com ; b@test.com ; c@test.com";
    const emails = raw
      .split(";")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);

    expect(emails).toEqual(["a@test.com", "b@test.com", "c@test.com"]);
  });

  it("filters out empty entries", () => {
    const raw = "a@test.com;;b@test.com;";
    const emails = raw
      .split(";")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);

    expect(emails).toEqual(["a@test.com", "b@test.com"]);
  });

  it("handles single email", () => {
    const raw = "speaker@test.com";
    const emails = raw
      .split(";")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);

    expect(emails).toEqual(["speaker@test.com"]);
  });
});

// ── Row-level validation for registrations ──────────────────────────

describe("Registration row validation", () => {
  it("extracts required fields from a valid row", () => {
    const csv =
      "email,firstName,lastName\njohn@test.com,John,Doe\njane@test.com,Jane,Smith";
    const { headers, rows } = parseCSV(csv);

    const idx = {
      email: headers.indexOf("email"),
      firstName: headers.indexOf("firstname"),
      lastName: headers.indexOf("lastname"),
    };

    // First data row
    const email = getField(rows[0], idx.email)?.toLowerCase();
    const firstName = getField(rows[0], idx.firstName);
    const lastName = getField(rows[0], idx.lastName);

    expect(email).toBe("john@test.com");
    expect(firstName).toBe("John");
    expect(lastName).toBe("Doe");
  });

  it("detects missing email in a row", () => {
    const csv = "email,firstName,lastName\n,John,Doe";
    const { headers, rows } = parseCSV(csv);

    const idx = { email: headers.indexOf("email") };
    const email = getField(rows[0], idx.email);

    expect(email).toBeUndefined();
  });

  it("parses tags from a registration row", () => {
    const csv = "email,firstName,lastName,tags\njohn@test.com,John,Doe,\"vip,speaker,sponsor\"";
    const { headers, rows } = parseCSV(csv);

    const tagsIdx = headers.indexOf("tags");
    const tags = parseTags(getField(rows[0], tagsIdx));

    expect(tags).toEqual(["vip", "speaker", "sponsor"]);
  });
});

// ── Full CSV parsing for each entity type ───────────────────────────

describe("End-to-end CSV parsing — registrations", () => {
  it("parses a complete registration CSV", () => {
    const csv = [
      "email,firstName,lastName,organization,title,tags,registrationType",
      "john@acme.com,John,Doe,Acme Corp,Dr,\"vip,speaker\",Gold Pass",
      "jane@acme.com,Jane,Smith,Acme Corp,Ms,,Standard",
    ].join("\n");

    const { headers, rows, error } = parseCSV(csv);
    expect(error).toBeUndefined();
    expect(rows).toHaveLength(2);

    // Verify header normalization
    expect(headers).toContain("registrationtype");

    // Verify data extraction
    const emailIdx = headers.indexOf("email");
    const titleIdx = headers.indexOf("title");
    const tagsIdx = headers.indexOf("tags");

    expect(getField(rows[0], emailIdx)).toBe("john@acme.com");
    const titleRaw = getField(rows[0], titleIdx)?.toUpperCase();
    expect(TITLE_VALUES.has(titleRaw!)).toBe(true);
    expect(parseTags(getField(rows[0], tagsIdx))).toEqual(["vip", "speaker"]);

    // Second row has empty tags
    expect(parseTags(getField(rows[1], tagsIdx))).toEqual([]);
  });
});

describe("End-to-end CSV parsing — speakers", () => {
  it("parses a complete speakers CSV", () => {
    const csv = [
      "email,firstName,lastName,organization,bio,status,title",
      "speaker1@test.com,Alice,Johnson,MIT,\"AI researcher, expert\",CONFIRMED,Prof",
      "speaker2@test.com,Bob,Williams,Stanford,,INVITED,Dr",
    ].join("\n");

    const { headers, rows, error } = parseCSV(csv);
    expect(error).toBeUndefined();
    expect(rows).toHaveLength(2);

    const statusIdx = headers.indexOf("status");
    const bioIdx = headers.indexOf("bio");

    // First row
    const status1 = getField(rows[0], statusIdx)?.toUpperCase();
    expect(SPEAKER_STATUS_VALUES.has(status1!)).toBe(true);
    expect(getField(rows[0], bioIdx)).toBe("AI researcher, expert");

    // Second row — empty bio
    expect(getField(rows[1], bioIdx)).toBeUndefined();
  });
});

describe("End-to-end CSV parsing — sessions", () => {
  it("parses a complete sessions CSV", () => {
    const csv = [
      "name,startTime,endTime,track,speakerEmails,status,capacity",
      "Opening Keynote,2026-03-15T09:00:00Z,2026-03-15T10:00:00Z,Main Stage,speaker1@t.com;speaker2@t.com,SCHEDULED,500",
      "Workshop A,2026-03-15T10:30:00Z,2026-03-15T12:00:00Z,Workshops,,DRAFT,30",
    ].join("\n");

    const { headers, rows, error } = parseCSV(csv);
    expect(error).toBeUndefined();
    expect(rows).toHaveLength(2);

    const nameIdx = headers.indexOf("name");
    const startIdx = headers.indexOf("starttime");
    const endIdx = headers.indexOf("endtime");
    const speakerIdx = headers.indexOf("speakeremails");
    const capacityIdx = headers.indexOf("capacity");

    // First row
    expect(getField(rows[0], nameIdx)).toBe("Opening Keynote");
    const start = new Date(getField(rows[0], startIdx)!);
    const end = new Date(getField(rows[0], endIdx)!);
    expect(isNaN(start.getTime())).toBe(false);
    expect(end > start).toBe(true);

    // Speaker emails
    const emails = getField(rows[0], speakerIdx)!
      .split(";")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
    expect(emails).toEqual(["speaker1@t.com", "speaker2@t.com"]);

    // Capacity
    const capacity = parseInt(getField(rows[0], capacityIdx)!, 10);
    expect(capacity).toBe(500);

    // Second row — no speakers
    expect(getField(rows[1], speakerIdx)).toBeUndefined();
  });
});

describe("End-to-end CSV parsing — abstracts", () => {
  it("parses a complete abstracts CSV", () => {
    const csv = [
      "title,content,speakerEmail,specialty,track,status",
      'Machine Learning in Healthcare,"Abstract content about ML applications in healthcare diagnosis and treatment",ml@test.com,AI/ML,Research Track,SUBMITTED',
      "Quantum Computing Basics,Introduction to quantum computing concepts,quantum@test.com,,Tutorials,ACCEPTED",
    ].join("\n");

    const { headers, rows, error } = parseCSV(csv);
    expect(error).toBeUndefined();
    expect(rows).toHaveLength(2);

    const titleIdx = headers.indexOf("title");
    const contentIdx = headers.indexOf("content");
    const emailIdx = headers.indexOf("speakeremail");
    const statusIdx = headers.indexOf("status");
    const specialtyIdx = headers.indexOf("specialty");

    // First row
    expect(getField(rows[0], titleIdx)).toBe("Machine Learning in Healthcare");
    expect(getField(rows[0], contentIdx)).toContain("ML applications");
    expect(getField(rows[0], emailIdx)).toBe("ml@test.com");
    expect(ABSTRACT_STATUS_VALUES.has(getField(rows[0], statusIdx)!)).toBe(true);
    expect(getField(rows[0], specialtyIdx)).toBe("AI/ML");

    // Second row — no specialty
    expect(getField(rows[1], specialtyIdx)).toBeUndefined();
    expect(ABSTRACT_STATUS_VALUES.has(getField(rows[1], statusIdx)!)).toBe(true);
  });
});
