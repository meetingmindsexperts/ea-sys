import { describe, it, expect } from "vitest";
import { AttendeeRole } from "@prisma/client";
import {
  buildCentralRow,
  type ContactForSync,
  type EventMeta,
} from "@/lib/contacts-central-sync";
import { formatAttendeeRole } from "@/lib/schemas";

const NOW = "2026-07-06T00:00:00.000Z";

function contact(o: Partial<ContactForSync> = {}): ContactForSync {
  return {
    email: "Ada@Example.com",
    firstName: "Ada",
    lastName: "Lovelace",
    organization: "Analytical Engines",
    jobTitle: "Mathematician",
    phone: "+441234",
    city: "London",
    country: "United Kingdom",
    specialty: "Cardiology",
    customSpecialty: null,
    role: AttendeeRole.PHYSICIAN,
    tags: ["vip", "vip", "gold"],
    eventIds: ["e1", "e2", "eX"],
    registrationType: "Delegate",
    ...o,
  };
}

const eventMeta = new Map<string, EventMeta>([
  ["e1", { name: "MedCon 2026", specialty: "Cardiology", eventType: "CONFERENCE", tag: "flagship" }],
  ["e2", { name: "Heart Forum", specialty: "Cardiology", eventType: "WEBINAR", tag: "series" }],
  // "eX" intentionally absent → dropped
]);
const regTypes = new Map<string, string[]>([["ada@example.com", ["Delegate", "Speaker"]]]);

describe("buildCentralRow", () => {
  it("maps identity, lowercases email, dedups arrays, drops unknown events", () => {
    const r = buildCentralRow(contact(), eventMeta, regTypes, NOW);
    expect(r.email).toBe("ada@example.com");
    expect(r.first_name).toBe("Ada");
    expect(r.last_name).toBe("Lovelace");
    expect(r.organization_name).toBe("Analytical Engines");
    expect(r.job_title).toBe("Mathematician");
    expect(r.mobile).toBe("+441234");
    expect(r.role).toBe(formatAttendeeRole(AttendeeRole.PHYSICIAN));
    expect(r.tags).toEqual(["vip", "gold"]);
    expect(r.events_attended).toEqual(["MedCon 2026", "Heart Forum"]);
    expect(new Set(r.event_type)).toEqual(new Set(["CONFERENCE", "WEBINAR"]));
    expect(r.event_speciality).toEqual(["Cardiology"]); // deduped across both events
    expect(new Set(r.event_group)).toEqual(new Set(["flagship", "series"]));
    expect(new Set(r.registration_type)).toEqual(new Set(["Delegate", "Speaker"]));
    expect(r.last_updated).toBe(NOW);
  });

  it("speciality: Others + customSpecialty → the custom value", () => {
    const r = buildCentralRow(
      contact({ specialty: "Others", customSpecialty: "Neuro-oncology" }),
      eventMeta,
      regTypes,
      NOW,
    );
    expect(r.speciality).toBe("Neuro-oncology");
  });

  it("nulls empty scalars and yields empty arrays when there's nothing", () => {
    const r = buildCentralRow(
      contact({
        email: "x@y.com",
        organization: null,
        jobTitle: null,
        phone: null,
        city: null,
        country: null,
        specialty: null,
        customSpecialty: null,
        role: null,
        tags: [],
        eventIds: [],
        registrationType: null,
      }),
      eventMeta,
      new Map(),
      NOW,
    );
    expect(r.organization_name).toBeNull();
    expect(r.role).toBeNull();
    expect(r.speciality).toBeNull();
    expect(r.tags).toEqual([]);
    expect(r.events_attended).toEqual([]);
    expect(r.registration_type).toEqual([]);
  });

  it("registration_type = union of the reg-type map + contact.registrationType", () => {
    const r = buildCentralRow(
      contact({ email: "solo@z.com", registrationType: "Student", eventIds: [] }),
      eventMeta,
      new Map(),
      NOW,
    );
    expect(r.registration_type).toEqual(["Student"]);
  });
});
