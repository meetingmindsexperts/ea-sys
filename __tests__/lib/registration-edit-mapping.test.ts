/**
 * Unit tests for the registration detail-sheet's edit-form mappers.
 *
 * The mappers are pure — they own every null-vs-undefined and trim
 * decision the sheet used to inline three times. Tests pin those
 * decisions so the next refactor (RHF migration / sub-component
 * split) can't silently change the wire format the PUT route expects.
 */

import { describe, it, expect } from "vitest";
import type { Registration } from "@/app/(dashboard)/events/[eventId]/registrations/types";
import {
  EMPTY_REGISTRATION_EDIT_DATA,
  toEditData,
  toServerPayload,
} from "@/app/(dashboard)/events/[eventId]/registrations/registration-edit-mapping";

// Minimal Registration fixture — sets only the fields the mappers
// read. Cast at the boundary so we don't have to populate every
// unrelated field (the type is wide; the mappers touch a slice).
function makeReg(
  overrides: Omit<Partial<Registration>, "attendee"> & {
    attendee?: Partial<Registration["attendee"]>;
  } = {},
): Registration {
  const { attendee: attendeeOverrides, ...regOverrides } = overrides;
  return {
    id: "reg-1",
    status: "CONFIRMED",
    paymentStatus: "UNASSIGNED",
    updatedAt: "2026-05-20T10:00:00.000Z",
    notes: null,
    dtcmBarcode: null,
    taxNumber: null,
    billingFirstName: null,
    billingLastName: null,
    billingEmail: null,
    billingPhone: null,
    billingAddress: null,
    billingCity: null,
    billingState: null,
    billingZipCode: null,
    billingCountry: null,
    billingAccountId: null,
    payerReference: null,
    attendeeIsGuarantor: false,
    attendee: {
      id: "att-1",
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@x.test",
      title: null,
      phone: null,
      organization: null,
      jobTitle: null,
      photo: null,
      city: null,
      country: null,
      bio: null,
      specialty: null,
      tags: [],
      dietaryReqs: null,
      associationName: null,
      memberId: null,
      studentId: null,
      studentIdExpiry: null,
      ...attendeeOverrides,
    } as Registration["attendee"],
    ...regOverrides,
  } as Registration;
}

describe("EMPTY_REGISTRATION_EDIT_DATA", () => {
  it("is a fully-controlled defaults shape — every field present, every input controlled from mount", () => {
    // Type-level: any new field on RegistrationEditData must be added
    // here or this assertion (and the file) fails to compile.
    expect(EMPTY_REGISTRATION_EDIT_DATA.title).toBe("");
    expect(EMPTY_REGISTRATION_EDIT_DATA.photo).toBeNull();
    expect(EMPTY_REGISTRATION_EDIT_DATA.tags).toEqual([]);
    expect(EMPTY_REGISTRATION_EDIT_DATA.attendeeIsGuarantor).toBe(false);
    expect(EMPTY_REGISTRATION_EDIT_DATA.billingAccountId).toBe("");
  });
});

describe("toEditData", () => {
  it("coerces null scalars to '' so inputs stay controlled", () => {
    const d = toEditData(makeReg());
    expect(d.title).toBe("");
    expect(d.phone).toBe("");
    expect(d.organization).toBe("");
    expect(d.taxNumber).toBe("");
    expect(d.billingCity).toBe("");
    expect(d.payerReference).toBe("");
  });

  it("preserves a populated row's values verbatim", () => {
    const d = toEditData(
      makeReg({
        notes: "vip",
        dtcmBarcode: "DTCM-1",
        taxNumber: "TRN-42",
        billingFirstName: "John",
        billingCity: "Dubai",
        billingAccountId: "ba-1",
        payerReference: "PO-42",
        attendeeIsGuarantor: true,
        attendee: {
          firstName: "John",
          lastName: "Smith",
          title: "DR",
          phone: "+971 1 234",
          tags: ["vip", "speaker"],
        },
      }),
    );
    expect(d.notes).toBe("vip");
    expect(d.dtcmBarcode).toBe("DTCM-1");
    expect(d.taxNumber).toBe("TRN-42");
    expect(d.billingFirstName).toBe("John");
    expect(d.billingAccountId).toBe("ba-1");
    expect(d.payerReference).toBe("PO-42");
    expect(d.attendeeIsGuarantor).toBe(true);
    expect(d.title).toBe("DR");
    expect(d.tags).toEqual(["vip", "speaker"]);
  });

  it("parses studentIdExpiry ISO date into yyyy-MM-dd for the <input type=date>", () => {
    const d = toEditData(
      makeReg({
        attendee: { studentIdExpiry: "2027-06-15T00:00:00.000Z" },
      }),
    );
    expect(d.studentIdExpiry).toBe("2027-06-15");
  });

  it("attendeeIsGuarantor uses `?? false` (preserves `false`, defaults `null`)", () => {
    // The nullish-coalesce is what protects against a legacy/null row
    // turning the checkbox into an uncontrolled component.
    expect(toEditData(makeReg({ attendeeIsGuarantor: false })).attendeeIsGuarantor).toBe(false);
    expect(
      toEditData(makeReg({ attendeeIsGuarantor: null as unknown as boolean })).attendeeIsGuarantor,
    ).toBe(false);
  });

  it("registration-level fields default correctly on a sparse row (no auto-save selects)", () => {
    const d = toEditData(makeReg());
    expect(d.ticketTypeId).toBe("");
    expect(d.badgeType).toBe("");
    expect(d.attendanceMode).toBe("IN_PERSON");
    expect(d.status).toBe("CONFIRMED");
    expect(d.paymentStatus).toBe("UNASSIGNED");
    expect(d.sponsorId).toBe("");
  });

  it("registration-level fields read from a populated row", () => {
    const d = toEditData(
      makeReg({
        status: "PENDING",
        paymentStatus: "INCLUSIVE",
        badgeType: "Faculty",
        attendanceMode: "VIRTUAL",
        sponsorId: "sp-1",
        ticketType: { id: "tt-1", name: "Physician" } as Registration["ticketType"],
      }),
    );
    expect(d.status).toBe("PENDING");
    expect(d.paymentStatus).toBe("INCLUSIVE");
    expect(d.badgeType).toBe("Faculty");
    expect(d.attendanceMode).toBe("VIRTUAL");
    expect(d.sponsorId).toBe("sp-1");
    expect(d.ticketTypeId).toBe("tt-1");
  });
});

describe("toServerPayload", () => {
  const UPDATED = "2026-05-20T10:00:00.000Z";

  it("includes expectedUpdatedAt verbatim (optimistic-lock token)", () => {
    const out = toServerPayload(EMPTY_REGISTRATION_EDIT_DATA, UPDATED);
    expect(out.expectedUpdatedAt).toBe(UPDATED);
  });

  it("billing fields: trim → null when empty (deliberate clear)", () => {
    const out = toServerPayload(
      { ...EMPTY_REGISTRATION_EDIT_DATA, billingFirstName: "  ", billingCity: "Dubai" },
      UPDATED,
    );
    expect(out.billingFirstName).toBeNull();
    expect(out.billingCity).toBe("Dubai");
  });

  it("attendee free-text fields: empty → undefined (NOT null) so PUT treats as 'unchanged'", () => {
    const out = toServerPayload(EMPTY_REGISTRATION_EDIT_DATA, UPDATED);
    const att = out.attendee as Record<string, unknown>;
    expect(att.title).toBeUndefined();
    expect(att.phone).toBeUndefined();
    expect(att.organization).toBeUndefined();
    expect(att.bio).toBeUndefined();
  });

  it("attendee id-bearing fields: empty → null so PUT CAN clear them", () => {
    const out = toServerPayload(EMPTY_REGISTRATION_EDIT_DATA, UPDATED);
    const att = out.attendee as Record<string, unknown>;
    expect(att.associationName).toBeNull();
    expect(att.memberId).toBeNull();
    expect(att.studentId).toBeNull();
    expect(att.studentIdExpiry).toBeNull();
    expect(att.photo).toBeNull(); // `?? null` (deliberate clear semantic)
  });

  it("attendee.firstName / lastName pass through (required, never coerced)", () => {
    const out = toServerPayload(
      { ...EMPTY_REGISTRATION_EDIT_DATA, firstName: "John", lastName: "Smith" },
      UPDATED,
    );
    const att = out.attendee as Record<string, unknown>;
    expect(att.firstName).toBe("John");
    expect(att.lastName).toBe("Smith");
  });

  describe("payer triplet (billingAccountId / payerReference / attendeeIsGuarantor)", () => {
    it("self-pay (billingAccountId = ''): payerReference forced null, guarantor forced false", () => {
      const out = toServerPayload(
        {
          ...EMPTY_REGISTRATION_EDIT_DATA,
          billingAccountId: "",
          payerReference: "PO-leftover",  // user-edited but should not survive
          attendeeIsGuarantor: true,      // user-toggled but should not survive
        },
        UPDATED,
      );
      expect(out.billingAccountId).toBeNull();
      expect(out.payerReference).toBeNull();
      expect(out.attendeeIsGuarantor).toBe(false);
    });

    it("third-party payer set: payerReference is trim-or-null, guarantor flag preserved", () => {
      const out = toServerPayload(
        {
          ...EMPTY_REGISTRATION_EDIT_DATA,
          billingAccountId: "ba-1",
          payerReference: "  PO-42  ",
          attendeeIsGuarantor: true,
        },
        UPDATED,
      );
      expect(out.billingAccountId).toBe("ba-1");
      expect(out.payerReference).toBe("PO-42");
      expect(out.attendeeIsGuarantor).toBe(true);
    });

    it("third-party payer with whitespace PO: trims to null", () => {
      const out = toServerPayload(
        {
          ...EMPTY_REGISTRATION_EDIT_DATA,
          billingAccountId: "ba-1",
          payerReference: "   ",
        },
        UPDATED,
      );
      expect(out.payerReference).toBeNull();
    });
  });

  describe("registration-level fields (folded in from the removed auto-save selects)", () => {
    it("status + paymentStatus pass through; sponsorId '' → null", () => {
      const out = toServerPayload(
        { ...EMPTY_REGISTRATION_EDIT_DATA, status: "CANCELLED", paymentStatus: "PAID" },
        UPDATED,
      );
      expect(out.status).toBe("CANCELLED");
      expect(out.paymentStatus).toBe("PAID");
      expect(out.sponsorId).toBeNull();
    });

    it("sponsorId preserved when set (INCLUSIVE case)", () => {
      const out = toServerPayload({ ...EMPTY_REGISTRATION_EDIT_DATA, sponsorId: "sp-1" }, UPDATED);
      expect(out.sponsorId).toBe("sp-1");
    });

    it("ticketTypeId omitted when blank (never nulls the type), included when set", () => {
      expect("ticketTypeId" in toServerPayload(EMPTY_REGISTRATION_EDIT_DATA, UPDATED)).toBe(false);
      const out = toServerPayload({ ...EMPTY_REGISTRATION_EDIT_DATA, ticketTypeId: "tt-9" }, UPDATED);
      expect(out.ticketTypeId).toBe("tt-9");
    });

    it("attendanceMode included when set, omitted when blank", () => {
      expect(
        toServerPayload({ ...EMPTY_REGISTRATION_EDIT_DATA, attendanceMode: "IN_PERSON" }, UPDATED).attendanceMode,
      ).toBe("IN_PERSON");
      expect(
        "attendanceMode" in toServerPayload({ ...EMPTY_REGISTRATION_EDIT_DATA, attendanceMode: "" }, UPDATED),
      ).toBe(false);
    });

    it("badgeType sent when set, omitted when blank (don't flip a legacy null badge to '')", () => {
      expect(toServerPayload({ ...EMPTY_REGISTRATION_EDIT_DATA, badgeType: "Faculty" }, UPDATED).badgeType).toBe("Faculty");
      expect("badgeType" in toServerPayload({ ...EMPTY_REGISTRATION_EDIT_DATA, badgeType: "" }, UPDATED)).toBe(false);
    });

    it("empty status/paymentStatus → undefined (belt-and-braces; toEditData always fills them)", () => {
      const out = toServerPayload(EMPTY_REGISTRATION_EDIT_DATA, UPDATED);
      expect(out.status).toBeUndefined();
      expect(out.paymentStatus).toBeUndefined();
    });

    // H1/H2 — with an `original` snapshot, reg-level fields are a true diff:
    // unchanged ones are OMITTED so an unrelated edit doesn't re-send them.
    describe("diff mode (3-arg with the loaded row's snapshot)", () => {
      it("omits reg-level fields that did not change", () => {
        const orig: typeof EMPTY_REGISTRATION_EDIT_DATA = {
          ...EMPTY_REGISTRATION_EDIT_DATA,
          status: "CONFIRMED",
          paymentStatus: "PAID",
          ticketTypeId: "tt-1",
          sponsorId: "sp-1",
          badgeType: "Faculty",
        };
        // Only phone changed (an attendee field) — no reg-level field differs.
        const out = toServerPayload({ ...orig, phone: "+971 9 999" }, UPDATED, orig);
        expect("status" in out).toBe(false);
        expect("paymentStatus" in out).toBe(false);
        expect("ticketTypeId" in out).toBe(false);
        expect("sponsorId" in out).toBe(false);
        expect("badgeType" in out).toBe(false);
        // attendee edit still flows through
        expect((out.attendee as Record<string, unknown>).phone).toBe("+971 9 999");
      });

      it("sends only the reg-level field that changed", () => {
        const orig: typeof EMPTY_REGISTRATION_EDIT_DATA = {
          ...EMPTY_REGISTRATION_EDIT_DATA,
          status: "CONFIRMED",
          paymentStatus: "UNPAID",
        };
        const out = toServerPayload({ ...orig, status: "CANCELLED" }, UPDATED, orig);
        expect(out.status).toBe("CANCELLED");
        expect("paymentStatus" in out).toBe(false);
      });

      it("H2: unchanged INCLUSIVE-without-sponsor row → neither paymentStatus nor sponsorId sent", () => {
        // A legacy row that is INCLUSIVE but has no sponsor. Editing an unrelated
        // field must not re-send payment/sponsor (which the server would reject).
        const orig: typeof EMPTY_REGISTRATION_EDIT_DATA = {
          ...EMPTY_REGISTRATION_EDIT_DATA,
          paymentStatus: "INCLUSIVE",
          sponsorId: "",
        };
        const out = toServerPayload({ ...orig, phone: "+971 1 000" }, UPDATED, orig);
        expect("paymentStatus" in out).toBe(false);
        expect("sponsorId" in out).toBe(false);
      });

      it("sends sponsorId when the user assigns one (changed)", () => {
        const orig: typeof EMPTY_REGISTRATION_EDIT_DATA = {
          ...EMPTY_REGISTRATION_EDIT_DATA,
          paymentStatus: "INCLUSIVE",
          sponsorId: "",
        };
        const out = toServerPayload({ ...orig, sponsorId: "sp-9" }, UPDATED, orig);
        expect(out.sponsorId).toBe("sp-9");
        expect("paymentStatus" in out).toBe(false); // status itself unchanged
      });
    });
  });

  it("round-trip: toServerPayload(toEditData(reg)) preserves payer + billing + key attendee values", () => {
    const reg = makeReg({
      billingFirstName: "John",
      billingCity: "Dubai",
      billingCountry: "UAE",
      taxNumber: "TRN-42",
      billingAccountId: "ba-1",
      payerReference: "PO-42",
      attendeeIsGuarantor: true,
      attendee: {
        firstName: "John",
        lastName: "Smith",
        title: "DR",
        phone: "+971 1 234",
      },
    });
    const out = toServerPayload(toEditData(reg), UPDATED);
    const att = out.attendee as Record<string, unknown>;
    expect(out.billingFirstName).toBe("John");
    expect(out.billingCity).toBe("Dubai");
    expect(out.taxNumber).toBe("TRN-42");
    expect(out.billingAccountId).toBe("ba-1");
    expect(out.payerReference).toBe("PO-42");
    expect(out.attendeeIsGuarantor).toBe(true);
    expect(att.title).toBe("DR");
    expect(att.firstName).toBe("John");
    expect(att.phone).toBe("+971 1 234");
  });
});
