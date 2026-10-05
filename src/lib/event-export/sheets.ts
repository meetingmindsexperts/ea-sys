/**
 * Event data export: the sheets that had NO export of their own before the
 * bundle (Sep 30, 2026). Every other area in the bundle comes from its
 * existing export route, called in-process (see bundle.ts), so each column
 * list has exactly one definition.
 *
 * Server-only (Prisma). Every cell goes through the shared CSV escaper, so a
 * formula-shaped value cannot execute in Excel. Money columns are included
 * only for callers who may see them, by the same predicates as the screens:
 * prices by `canViewFinance`, the speaker honorarium by
 * `canManageReimbursements`.
 */
import { db } from "@/lib/db";
import { toCsvRow } from "@/lib/csv-escape";
import { formatPersonName } from "@/lib/utils";
import { can, type Principal } from "@/lib/permissions/can";

export interface Sheet {
  /** Path inside the ZIP. */
  file: string;
  csv: string;
  rows: number;
}

type Cell = unknown;

function sheet(file: string, header: string[], rows: Cell[][]): Sheet {
  return { file, csv: [toCsvRow(header), ...rows.map((r) => toCsvRow(r))].join("\n"), rows: rows.length };
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : "");
const money = (v: { toString(): string } | null | undefined) => (v == null ? "" : v.toString());
const person = (p: { title: string | null; firstName: string; lastName: string } | null | undefined) =>
  p ? formatPersonName(p.title, p.firstName, p.lastName) : "";

/** One row of event facts, so the ZIP says which event it is without the app. */
export async function eventSheet(eventId: string, principal: Principal): Promise<Sheet> {
  const e = await db.event.findFirstOrThrow({
    where: { id: eventId },
    select: {
      id: true,
      name: true,
      slug: true,
      code: true,
      eventType: true,
      status: true,
      startDate: true,
      endDate: true,
      timezone: true,
      venue: true,
      address: true,
      city: true,
      country: true,
      tag: true,
      specialty: true,
      taxRate: true,
      taxLabel: true,
      createdAt: true,
    },
  });
  const finance = can(principal, "finance.view");
  const header = ["Event ID", "Name", "Slug", "Code", "Type", "Status", "Start", "End", "Timezone", "Venue", "Address", "City", "Country", "Tag", "Specialty", ...(finance ? ["Tax Rate", "Tax Label"] : []), "Created At"];
  const row = [e.id, e.name, e.slug, e.code, e.eventType, e.status, iso(e.startDate), iso(e.endDate), e.timezone, e.venue, e.address, e.city, e.country, e.tag, e.specialty, ...(finance ? [money(e.taxRate), e.taxLabel] : []), iso(e.createdAt)];
  return sheet("event.csv", header, [row]);
}

export async function speakersSheet(eventId: string, principal: Principal): Promise<Sheet> {
  const honorarium = can(principal, "honorarium.view");
  const speakers = await db.speaker.findMany({
    where: { eventId },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    select: {
      id: true,
      title: true,
      firstName: true,
      lastName: true,
      email: true,
      additionalEmail: true,
      phone: true,
      organization: true,
      jobTitle: true,
      city: true,
      state: true,
      country: true,
      specialty: true,
      customSpecialty: true,
      registrationType: true,
      status: true,
      tags: true,
      website: true,
      bio: true,
      agreementAcceptedAt: true,
      presenterAgreementAcceptedAt: true,
      honorariumAmount: true,
      honorariumCurrency: true,
      sourceRegistrationId: true,
      createdAt: true,
      sessions: { select: { role: true, session: { select: { name: true } } } },
    },
  });
  const header = [
    "Speaker ID", "Name", "Title", "First Name", "Last Name", "Email", "Additional Email", "Phone",
    "Organization", "Job Title", "City", "State", "Country", "Specialty", "Registration Type", "Status",
    "Tags", "Website", "Sessions (role)", "Speaker Agreement Accepted", "Presenter Agreement Accepted",
    ...(honorarium ? ["Honorarium", "Honorarium Currency"] : []),
    "Has Companion Registration", "Bio", "Created At",
  ];
  const rows = speakers.map((s) => [
    s.id, person(s), s.title ?? "", s.firstName, s.lastName, s.email, s.additionalEmail, s.phone,
    s.organization, s.jobTitle, s.city, s.state, s.country, s.customSpecialty || s.specialty, s.registrationType, s.status,
    s.tags.join("; "), s.website, s.sessions.map((x) => `${x.session.name} (${x.role})`).join("; "),
    iso(s.agreementAcceptedAt), iso(s.presenterAgreementAcceptedAt),
    ...(honorarium ? [money(s.honorariumAmount), s.honorariumCurrency] : []),
    s.sourceRegistrationId ? "Yes" : "No", s.bio, iso(s.createdAt),
  ]);
  return sheet("speakers.csv", header, rows);
}

/**
 * The programme: one row per session, then (in a second sheet) one row per
 * topic, so a session with talks inside it reads naturally in a spreadsheet.
 */
export async function sessionSheets(eventId: string): Promise<Sheet[]> {
  const sessions = await db.eventSession.findMany({
    where: { eventId },
    orderBy: [{ startTime: "asc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      description: true,
      startTime: true,
      endTime: true,
      location: true,
      capacity: true,
      status: true,
      type: true,
      track: { select: { name: true } },
      abstract: { select: { serialId: true, title: true } },
      speakers: { select: { role: true, speaker: { select: { title: true, firstName: true, lastName: true } } } },
      topics: {
        orderBy: { sortOrder: "asc" },
        select: {
          id: true,
          title: true,
          duration: true,
          sortOrder: true,
          speakers: { select: { speaker: { select: { title: true, firstName: true, lastName: true } } } },
        },
      },
    },
  });
  const sessionRows = sessions.map((s) => [
    s.id, s.name, s.type, s.status, iso(s.startTime), iso(s.endTime), s.location, s.track?.name ?? "",
    s.capacity ?? "", s.speakers.map((x) => `${person(x.speaker)} (${x.role})`).join("; "),
    s.topics.length, s.abstract ? `A-${String(s.abstract.serialId ?? "").padStart(3, "0")} ${s.abstract.title}` : "", s.description,
  ]);
  const topicRows = sessions.flatMap((s) =>
    s.topics.map((t) => [s.id, s.name, t.sortOrder + 1, t.title, t.duration ?? "", t.speakers.map((x) => person(x.speaker)).join("; ")]),
  );
  return [
    sheet("sessions.csv", ["Session ID", "Name", "Type", "Status", "Start", "End", "Location", "Track", "Capacity", "Speakers (role)", "Topics", "Linked Abstract", "Description"], sessionRows),
    sheet("session-topics.csv", ["Session ID", "Session", "Order", "Topic", "Duration (min)", "Speakers"], topicRows),
  ];
}

export async function accommodationSheets(eventId: string, principal: Principal): Promise<Sheet[]> {
  const finance = can(principal, "finance.view");
  const [bookings, hotels] = await Promise.all([
    db.accommodation.findMany({
      where: { eventId },
      orderBy: [{ checkIn: "asc" }],
      select: {
        id: true,
        checkIn: true,
        checkOut: true,
        guestCount: true,
        status: true,
        confirmationNo: true,
        specialRequests: true,
        totalPrice: true,
        currency: true,
        createdAt: true,
        roomType: { select: { name: true, hotel: { select: { name: true } } } },
        registration: { select: { serialId: true, attendee: { select: { title: true, firstName: true, lastName: true, email: true } } } },
        speaker: { select: { title: true, firstName: true, lastName: true, email: true } },
      },
    }),
    db.hotel.findMany({
      where: { eventId },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        address: true,
        stars: true,
        contactEmail: true,
        contactPhone: true,
        isActive: true,
        roomTypes: { orderBy: { name: "asc" }, select: { id: true, name: true, capacity: true, totalRooms: true, bookedRooms: true, pricePerNight: true, currency: true, isActive: true } },
      },
    }),
  ]);
  const bookingRows = bookings.map((b) => {
    const guest = b.registration?.attendee ?? b.speaker;
    return [
      b.id, guest ? person(guest) : "", guest?.email ?? "", b.registration ? "Registration" : b.speaker ? "Speaker" : "",
      b.registration?.serialId ?? "", b.roomType.hotel.name, b.roomType.name, iso(b.checkIn), iso(b.checkOut), b.guestCount,
      b.status, b.confirmationNo, ...(finance ? [money(b.totalPrice), b.currency] : []), b.specialRequests, iso(b.createdAt),
    ];
  });
  const roomRows = hotels.flatMap((h) =>
    h.roomTypes.length === 0
      ? [[h.id, h.name, h.stars ?? "", h.address, h.contactEmail, h.contactPhone, h.isActive ? "Yes" : "No", "", "", "", "", "", ...(finance ? ["", ""] : [])]]
      : h.roomTypes.map((r) => [
          h.id, h.name, h.stars ?? "", h.address, h.contactEmail, h.contactPhone, h.isActive ? "Yes" : "No",
          r.name, r.capacity, r.totalRooms, r.bookedRooms, r.isActive ? "Yes" : "No", ...(finance ? [money(r.pricePerNight), r.currency] : []),
        ]),
  );
  return [
    sheet(
      "accommodation-bookings.csv",
      ["Booking ID", "Guest", "Guest Email", "Guest Is", "Registration #", "Hotel", "Room Type", "Check In", "Check Out", "Guests", "Status", "Confirmation No", ...(finance ? ["Total Price", "Currency"] : []), "Special Requests", "Created At"],
      bookingRows,
    ),
    sheet(
      "hotels-and-rooms.csv",
      ["Hotel ID", "Hotel", "Stars", "Address", "Contact Email", "Contact Phone", "Hotel Active", "Room Type", "Capacity", "Total Rooms", "Booked Rooms", "Room Active", ...(finance ? ["Price Per Night", "Currency"] : [])],
      roomRows,
    ),
  ];
}

/** Registration types, one row per type and one per pricing tier beneath it. */
export async function registrationTypesSheet(eventId: string, principal: Principal): Promise<Sheet> {
  const finance = can(principal, "finance.view");
  const types = await db.ticketType.findMany({
    where: { eventId },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      category: true,
      isActive: true,
      isFaculty: true,
      price: true,
      virtualPrice: true,
      currency: true,
      quantity: true,
      soldCount: true,
      salesStart: true,
      salesEnd: true,
      requiresApproval: true,
      requiresDocument: true,
      pricingTiers: { orderBy: { sortOrder: "asc" }, select: { id: true, name: true, price: true, currency: true, quantity: true, soldCount: true, salesStart: true, salesEnd: true, isActive: true } },
    },
  });
  const rows: Cell[][] = [];
  for (const t of types) {
    rows.push([
      t.id, "Type", t.name, "", t.category, t.isActive ? "Yes" : "No", t.isFaculty ? "Yes" : "No",
      ...(finance ? [money(t.price), money(t.virtualPrice), t.currency] : []),
      t.quantity, t.soldCount, iso(t.salesStart), iso(t.salesEnd), t.requiresApproval ? "Yes" : "No", t.requiresDocument ? "Yes" : "No",
    ]);
    for (const p of t.pricingTiers) {
      rows.push([
        p.id, "Pricing tier", t.name, p.name, t.category, p.isActive ? "Yes" : "No", "",
        ...(finance ? [money(p.price), "", p.currency] : []),
        p.quantity, p.soldCount, iso(p.salesStart), iso(p.salesEnd), "", "",
      ]);
    }
  }
  return sheet(
    "registration-types.csv",
    ["ID", "Row", "Registration Type", "Pricing Tier", "Category", "Active", "Faculty", ...(finance ? ["Price", "Virtual Price", "Currency"] : []), "Seats", "Sold", "Sales Start", "Sales End", "Needs Approval", "Needs Document"],
    rows,
  );
}

export async function promoCodesSheet(eventId: string, principal: Principal): Promise<Sheet> {
  const finance = can(principal, "finance.view");
  const codes = await db.promoCode.findMany({
    where: { eventId },
    orderBy: { code: "asc" },
    select: {
      id: true,
      code: true,
      description: true,
      discountType: true,
      discountValue: true,
      currency: true,
      maxUses: true,
      maxUsesPerEmail: true,
      usedCount: true,
      validFrom: true,
      validUntil: true,
      isActive: true,
      sponsorCoversFee: true,
      sponsor: { select: { name: true } },
      ticketTypes: { select: { ticketType: { select: { name: true } } } },
    },
  });
  const rows = codes.map((c) => [
    c.id, c.code, c.description, c.discountType, ...(finance ? [money(c.discountValue), c.currency] : []),
    c.maxUses ?? "", c.maxUsesPerEmail ?? "", c.usedCount, iso(c.validFrom), iso(c.validUntil), c.isActive ? "Yes" : "No",
    c.sponsor?.name ?? "", c.sponsorCoversFee ? "Yes" : "No", c.ticketTypes.map((x) => x.ticketType.name).join("; "),
  ]);
  return sheet(
    "promo-codes.csv",
    ["Promo Code ID", "Code", "Description", "Discount Type", ...(finance ? ["Discount Value", "Currency"] : []), "Max Uses", "Max Uses Per Email", "Used", "Valid From", "Valid Until", "Active", "Sponsor", "Sponsor Covers Fee", "Registration Types"],
    rows,
  );
}

export async function sponsorsSheet(eventId: string): Promise<Sheet> {
  const sponsors = await db.sponsor.findMany({
    where: { eventId },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      tier: true,
      websiteUrl: true,
      description: true,
      _count: { select: { registrations: true, promoCodes: true } },
    },
  });
  const rows = sponsors.map((s) => [s.id, s.name, s.tier, s.websiteUrl, s._count.registrations, s._count.promoCodes, s.description]);
  return sheet("sponsors.csv", ["Sponsor ID", "Name", "Tier", "Website", "Registrations Tagged", "Promo Codes", "Description"], rows);
}
