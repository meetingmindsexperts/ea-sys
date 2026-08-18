import { describe, it, expect } from "vitest";
import {
  screenContact,
  emailDomain,
  BLOCKED_EMAILS,
  DISPOSABLE_EMAIL_DOMAINS,
} from "@/lib/contact-import-blocklist";

const ok = { email: "dr.amina@hospital.ae", firstName: "Amina", lastName: "Rashid" };

describe("screenContact — legitimate contacts pass", () => {
  it("passes an ordinary delegate", () => {
    expect(screenContact(ok)).toEqual({ blocked: false });
  });

  it("passes a real person reachable at a shared inbox", () => {
    // The rule targets broken NAMES, not role EMAILS. A clinic whose only
    // contact route is info@ still has a real person behind it.
    expect(
      screenContact({ email: "info@abbarapolyclinic.com", firstName: "Ismail", lastName: "Abbara" }),
    ).toEqual({ blocked: false });
  });

  it("passes an organization that legitimately contains a dotted word", () => {
    expect(
      screenContact({ ...ok, organization: "St. Mary Hospital" }),
    ).toEqual({ blocked: false });
  });

  it("passes a hyphenated surname", () => {
    expect(screenContact({ ...ok, lastName: "Al-Mansoori" })).toEqual({ blocked: false });
  });
});

describe("screenContact — the two spam rows that prompted this", () => {
  it("blocks the racetrack.top row by explicit address", () => {
    const r = screenContact({
      email: "yhfee@chitthi.in",
      firstName: "Dont click me: https://racetrack.top/go/hezwgobsmq5dinbw?hs=3788dffeac41bf05a6b3ad186f559fff&",
      lastName: "7l4pnd",
      organization: "qw8hic",
    });
    expect(r.blocked).toBe(true);
    if (r.blocked) expect(r.reason).toBe("BLOCKED_EMAIL");
  });

  it("blocks the adult-site row by explicit address", () => {
    const r = screenContact({
      email: "s0910367764@gmail.com",
      firstName: "Son Sand 30EURo live https://sexdoll",
      lastName: "Son Sand 30EURo live https://sexdoll",
      organization: "Swingers web club",
    });
    expect(r.blocked).toBe(true);
    if (r.blocked) expect(r.reason).toBe("BLOCKED_EMAIL");
  });

  it("still blocks the same spam shape from a NEW address", () => {
    // The explicit list is a backstop, not the mechanism. A fresh throwaway
    // running the identical payload must be caught by the content rule, or the
    // list becomes a treadmill.
    const r = screenContact({
      email: "someone-new@gmail.com",
      firstName: "Dont click me: https://racetrack.top/go/abc",
      lastName: "x",
    });
    expect(r.blocked).toBe(true);
    if (r.blocked) expect(r.reason).toBe("URL_IN_TEXT");
  });
});

describe("screenContact — disposable domains", () => {
  it("blocks a known throwaway provider", () => {
    const r = screenContact({ ...ok, email: "person@mailinator.com" });
    expect(r.blocked).toBe(true);
    if (r.blocked) expect(r.reason).toBe("DISPOSABLE_DOMAIN");
  });

  it("blocks a subdomain of one", () => {
    const r = screenContact({ ...ok, email: "person@mail.mailinator.com" });
    expect(r.blocked).toBe(true);
  });

  it("does NOT block a look-alike domain", () => {
    // `endsWith` without the dot anchor would wrongly block both of these.
    expect(screenContact({ ...ok, email: "a@notmailinator.com" })).toEqual({ blocked: false });
    expect(screenContact({ ...ok, email: "a@mailinator.com.evil.net" })).toEqual({ blocked: false });
  });

  it("is case-insensitive on the address", () => {
    const r = screenContact({ ...ok, email: "Person@MAILINATOR.com" });
    expect(r.blocked).toBe(true);
  });
});

describe("screenContact — a name that is an email address", () => {
  it("blocks a harvested bounce mailbox recorded as a surname", () => {
    const r = screenContact({
      email: "postmaster@bayer.com",
      firstName: "NA",
      lastName: "postmaster@bayer.com",
    });
    expect(r.blocked).toBe(true);
    if (r.blocked) expect(r.reason).toBe("NAME_IS_EMAIL");
  });

  it("blocks it in the first-name position too", () => {
    const r = screenContact({ email: "x@y.com", firstName: "payables@milab.com", lastName: "NA" });
    expect(r.blocked).toBe(true);
    if (r.blocked) expect(r.reason).toBe("NAME_IS_EMAIL");
  });
});

describe("screenContact — URLs in a NAME (strict)", () => {
  it.each([
    ["scheme", "Dont click me: https://racetrack.top/go/x"],
    ["www prefix", "www.spam-site.com"],
    ["abuse TLD", "visit spam.club"],
    ["bit.ly shortener", "Click bit.ly/abcd"],
    ["telegram shortener", "t.me/spamchan"],
    ["whatsapp shortener", "wa.me/97150123456"],
  ])("blocks a %s in firstName", (_label, value) => {
    const r = screenContact({ ...ok, firstName: value });
    expect(r.blocked).toBe(true);
    if (r.blocked) expect(r.reason).toBe("URL_IN_TEXT");
  });

  // These are REAL names from the contact book. A generic word.word rule
  // (matching any token.token) deletes all 78 of them. This is the single most
  // important assertion in the file: the audience is Arabic, Filipino and South
  // Asian, and their ordinary name forms look domain-shaped.
  it.each([
    ["title typed without a space", "Dr.Omar"],
    ["title, uppercase", "DR.AHMED"],
    ["double title", "Prof.DR Abdelraouf"],
    ["Mr with no space", "Mr.Yasser"],
    ["Arabic Al prefix", "Al.Rayes"],
    ["Arabic Al prefix, lowercase", "Al.jehani"],
    ["Filipino Maria abbreviation", "Ma.Theresa"],
    ["Bangladeshi honorific", "Most.Gulshan Ara"],
  ])("does NOT block a real name: %s", (_label, value) => {
    expect(screenContact({ ...ok, firstName: value })).toEqual({ blocked: false });
    expect(screenContact({ ...ok, lastName: value })).toEqual({ blocked: false });
  });
});

describe("screenContact — URLs in employer / job title (lenient)", () => {
  // The rule that deleted two real people: a lab worker and a pharmacist whose
  // employer had been typed with its domain suffix. A company name ending in
  // .com is ordinary CRM data, and these fields never reach an email greeting.
  it.each([
    ["Gulf diagnostics chain", "Al borg medical laboratories.com"],
    ["clinic", "blue coast medical.com"],
    ["pharma", "Roche.com"],
    ["pharma", "Sanofi.com"],
    ["reference site", "Medscape.com"],
    ["multi-part TLD", "Doctors.net.uk"],
  ])("does NOT block an employer that looks like a domain: %s", (_label, value) => {
    expect(screenContact({ ...ok, organization: value })).toEqual({ blocked: false });
  });

  it("still blocks an explicit link in the organization", () => {
    const r = screenContact({ ...ok, organization: "https://spam.example" });
    expect(r.blocked).toBe(true);
    if (r.blocked) expect(r.reason).toBe("URL_IN_TEXT");
  });

  it("reports which field tripped it", () => {
    const r = screenContact({ ...ok, jobTitle: "visit https://spam.example" });
    expect(r.blocked).toBe(true);
    if (r.blocked) expect(r.detail).toContain("jobTitle");
  });
});

describe("list hygiene", () => {
  it("keeps blocked addresses lowercase, since the screen lowercases before comparing", () => {
    for (const e of BLOCKED_EMAILS) expect(e).toBe(e.toLowerCase());
  });

  it("keeps disposable domains bare, with no scheme or @", () => {
    for (const d of DISPOSABLE_EMAIL_DOMAINS) {
      expect(d).toBe(d.toLowerCase());
      expect(d).not.toContain("@");
      expect(d).not.toContain("/");
    }
  });

  it("extracts the domain from the LAST @, so a quoted local part cannot spoof it", () => {
    expect(emailDomain('"a@b"@real.com')).toBe("real.com");
    expect(emailDomain("no-at-sign")).toBe("");
  });
});
