import { describe, it, expect } from "vitest";
import { AttendeeRole } from "@prisma/client";
import {
  buildCentralRow,
  mergeWithExisting,
  type ContactForSync,
  type EventMeta,
  type CentralContactRow,
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

describe("mergeWithExisting", () => {
  const ours: CentralContactRow = {
    email: "ada@example.com",
    first_name: "Ada",
    last_name: "Lovelace",
    organization_name: "Analytical Engines",
    job_title: "Mathematician",
    mobile: "+441234",
    city: "London",
    country: "United Kingdom",
    speciality: "Cardiology",
    role: "Physician",
    tags: ["gold"],
    events_attended: ["MedCon 2026"],
    registration_type: ["Delegate"],
    event_speciality: ["Cardiology"],
    event_type: ["CONFERENCE"],
    event_group: ["flagship"],
    last_updated: NOW,
  };

  it("new email (no existing) → uses our values + source ea-sys + ea_synced true", () => {
    const p = mergeWithExisting(ours, undefined);
    expect(p.first_name).toBe("Ada");
    expect(p.source).toBe("ea-sys");
    expect(p.ea_synced).toBe(true);
    expect(p.tags).toEqual(["gold"]);
    expect(p.last_updated).toBe(NOW);
  });

  it("ea_synced is always true (provenance marker), even on an existing row", () => {
    const p = mergeWithExisting(ours, { email: "ada@example.com", source: "eventsair" });
    expect(p.ea_synced).toBe(true);
  });

  it("scalars ENRICH — keep existing non-empty, fill blanks from us", () => {
    const p = mergeWithExisting(ours, {
      email: "ada@example.com",
      organization_name: "Babbage & Co", // existing set → kept
      job_title: "", // empty → filled from us
      mobile: null, // null → filled from us
      source: "eventsair", // existing source kept
    });
    expect(p.organization_name).toBe("Babbage & Co"); // not overwritten
    expect(p.job_title).toBe("Mathematician"); // filled
    expect(p.mobile).toBe("+441234"); // filled
    expect(p.source).toBe("eventsair"); // preserved
  });

  it("arrays UNION with existing (add ours, dedup, never drop theirs)", () => {
    const p = mergeWithExisting(ours, {
      email: "ada@example.com",
      tags: ["silver", "gold"], // "gold" dup, "silver" from another source
      events_attended: ["Old Summit"], // from another source — must survive
    });
    expect(new Set(p.tags)).toEqual(new Set(["silver", "gold"]));
    expect(new Set(p.events_attended)).toEqual(new Set(["Old Summit", "MedCon 2026"]));
    // an array we don't have existing for stays as ours
    expect(p.registration_type).toEqual(["Delegate"]);
  });

  it("last_updated is always ours (freshness marker)", () => {
    const p = mergeWithExisting(ours, { email: "ada@example.com", last_updated: "2000-01-01T00:00:00.000Z" });
    expect(p.last_updated).toBe(NOW);
  });
});
