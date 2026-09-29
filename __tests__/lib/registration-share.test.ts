/**
 * Shared registration views, the rules (docs/REGISTRATION_SHARE_PLAN.md).
 * The guarantees: the owner's "safe set" holds by absence, each field writes
 * only its own key, and contact columns are selected only when switched on.
 */
import { describe, it, expect } from "vitest";
import {
  REGISTRATION_SHARE_FIELDS,
  REGISTRATION_VIEW_PRESETS,
  attendeeSelect,
  defaultRegistrationView,
  effectiveRegistrationFields,
  effectiveRegistrationStatuses,
  isViewExpired,
  projectRegistration,
  promoCodeUseWhere,
  registrationContactKeys,
  sponsorAttributionWhere,
  summarise,
  validateRegistrationView,
  type RegistrationShareRow,
  type SharedRegistration,
} from "@/lib/registration-share";

const row = (over: Partial<RegistrationShareRow> = {}): RegistrationShareRow => ({
  serialId: 12,
  status: "CONFIRMED",
  attendanceMode: "IN_PERSON",
  checkedInAt: null,
  createdAt: new Date("2026-09-20T09:00:00Z"),
  ticketType: { name: "Physician", isFaculty: false },
  promoCode: { code: "PFIZER100", sponsor: null },
  sponsor: { name: "Pfizer" },
  group: null,
  attendee: {
    title: "DR",
    firstName: "Lina",
    lastName: "Saad",
    organization: "Tawam Hospital",
    jobTitle: "Consultant",
    country: "UAE",
    specialty: "Cardiology",
    customSpecialty: null,
    registrationType: null,
    email: "lina@example.com",
    additionalEmail: "lina.alt@example.com",
    phone: "+971500000000",
  },
  ...over,
});

const FIELD_TO_KEY: Record<string, keyof SharedRegistration> = {
  organization: "organization",
  jobTitle: "jobTitle",
  country: "country",
  specialty: "specialty",
  registrationType: "registrationType",
  attendanceMode: "attendanceMode",
  status: "status",
  checkedIn: "checkedInAt",
  registeredAt: "registeredAt",
  promoCode: "promoCode",
  sponsor: "sponsor",
  email: "email",
  additionalEmail: "additionalEmail",
  phone: "phone",
};

describe("the safe set (owner ruling R2)", () => {
  it("no amount, payment, billing, document, barcode, note, dietary, custom or tracking field exists in the catalogue", () => {
    for (const f of REGISTRATION_SHARE_FIELDS) {
      expect(f.key.toLowerCase(), f.key).not.toMatch(/amount|price|paid|payment|refund|discount|billing|invoice|document|qr|dtcm|barcode|note|dietary|custom|utm|referrer|user/);
    }
  });

  it("contact fields are off by default and are the only contact-group keys", () => {
    expect(registrationContactKeys().sort()).toEqual(["additionalEmail", "email", "phone"]);
    for (const k of registrationContactKeys()) expect(defaultRegistrationView().fields).not.toContain(k);
  });

  it("presets only use catalogue keys", () => {
    const keys = new Set(REGISTRATION_SHARE_FIELDS.map((f) => f.key));
    for (const p of REGISTRATION_VIEW_PRESETS) for (const f of p.fields) expect(keys.has(f), `${p.key}.${f}`).toBe(true);
  });
});

describe("projection", () => {
  it("with nothing on, only number and name leave the server", () => {
    expect(projectRegistration(row(), new Set())).toEqual({ number: "012", name: "Dr. Lina Saad" });
  });

  it("each field writes its own key and nothing else", () => {
    for (const f of REGISTRATION_SHARE_FIELDS) {
      const keys = Object.keys(projectRegistration(row(), new Set([f.key]))).sort();
      expect(keys, f.key).toEqual(["name", "number", FIELD_TO_KEY[f.key]].sort());
    }
  });

  it("everything but contact on: no email or phone anywhere in the output", () => {
    const on = new Set(REGISTRATION_SHARE_FIELDS.filter((f) => f.group !== "contact").map((f) => f.key));
    const json = JSON.stringify(projectRegistration(row(), on));
    expect(json).not.toContain("example.com");
    expect(json).not.toContain("+971");
  });

  it("shows a faculty companion's profession, not 'Faculty'", () => {
    const r = row({ ticketType: { name: "Faculty", isFaculty: true }, attendee: { ...row().attendee, registrationType: "Physician" } });
    expect(projectRegistration(r, new Set(["registrationType"])).registrationType).toBe("Physician");
  });
});

describe("attendeeSelect", () => {
  it("names a contact column only when its field is on", () => {
    const sel = attendeeSelect(new Set(["organization"]));
    expect(sel).not.toHaveProperty("email");
    expect(sel).not.toHaveProperty("additionalEmail");
    expect(sel).not.toHaveProperty("phone");
    expect(attendeeSelect(new Set(["email", "phone"]))).toMatchObject({ email: true, phone: true });
  });
});

describe("validation and read-time filtering", () => {
  it("refuses unknown statuses and fields rather than dropping them", () => {
    expect(validateRegistrationView({ statuses: ["PAID"], fields: [] })).toMatchObject({ ok: false, code: "UNKNOWN_STATUS" });
    expect(validateRegistrationView({ statuses: ["CONFIRMED"], fields: ["originalPrice"] })).toMatchObject({ ok: false, code: "UNKNOWN_FIELD" });
    expect(validateRegistrationView({ statuses: [], fields: [] })).toMatchObject({ ok: false, code: "NO_STATUS" });
  });

  it("re-filters stored values at read time", () => {
    expect(effectiveRegistrationStatuses(["CONFIRMED", "DRAFT"])).toEqual(["CONFIRMED"]);
    expect([...effectiveRegistrationFields(["email", "paymentStatus"])]).toEqual(["email"]);
  });

  it("expiry: none never expires; the past has", () => {
    const now = new Date("2026-10-01T00:00:00Z");
    expect(isViewExpired(null, now)).toBe(false);
    expect(isViewExpired(new Date("2026-09-30T23:59:59Z"), now)).toBe(true);
    expect(isViewExpired("2026-10-02T00:00:00Z", now)).toBe(false);
  });
});

describe("summarise", () => {
  it("counts by type, by status and checked in", () => {
    const s = summarise([
      row(),
      row({ status: "CHECKED_IN", checkedInAt: new Date() }),
      row({ ticketType: { name: "Nurse", isFaculty: false } }),
    ]);
    expect(s.total).toBe(3);
    expect(s.checkedIn).toBe(1);
    expect(s.byType).toEqual([{ label: "Physician", count: 2 }, { label: "Nurse", count: 1 }]);
    expect(s.byStatus).toEqual([{ status: "CONFIRMED", count: 2 }, { status: "CHECKED_IN", count: 1 }]);
  });
});

describe("sponsor and promo code attribution (review M1-M3)", () => {
  const viaCode = row({ sponsor: null, promoCode: { code: "PFZ", sponsor: { name: "Pfizer" } } });
  const viaGroup = row({ sponsor: null, promoCode: null, group: { promoCode: { code: "GRP", sponsor: { name: "Novartis" } } } });

  it("shows the sponsor reached through the promo code or the group's code", () => {
    expect(projectRegistration(viaCode, new Set(["sponsor"])).sponsor).toBe("Pfizer");
    expect(projectRegistration(viaGroup, new Set(["sponsor", "promoCode"]))).toMatchObject({ sponsor: "Novartis", promoCode: "GRP" });
  });

  it("a direct tag wins over the code", () => {
    expect(projectRegistration(row({ promoCode: { code: "X", sponsor: { name: "Other" } } }), new Set(["sponsor"])).sponsor).toBe("Pfizer");
  });

  it("the where clauses carry all three sponsor arms and both promo arms", () => {
    expect(sponsorAttributionWhere(["s1"])).toEqual({
      OR: [
        { sponsorId: { in: ["s1"] } },
        { promoCode: { sponsorId: { in: ["s1"] } } },
        { group: { promoCode: { sponsorId: { in: ["s1"] } } } },
      ],
    });
    expect(promoCodeUseWhere(["p1"])).toEqual({ OR: [{ promoCodeId: { in: ["p1"] } }, { group: { promoCodeId: { in: ["p1"] } } }] });
  });
});
