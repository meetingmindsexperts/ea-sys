/**
 * The VALUES of the email tokens in the token map (email-token-map.ts), one
 * builder per group of tokens, called by every sender that lets a person pair
 * a template with an audience: the bulk pipeline (bulk-email.ts), the
 * registration record's send and the speaker page's send. Step 2 of
 * docs/EMAIL_TOKEN_MAP_PLAN.md: until Nov 27, 2026 each sender wrote its own
 * copy, and they had drifted (a reminder from the record said "1" day to go;
 * a saved template sent from Communications and was refused from the record).
 *
 * A sender spreads these and adds only what is its own (links it mints,
 * attachments, the blocks of one email type). `email-token-writers.test.ts`
 * lists the files that may assign a mapped token.
 */
import { eventLocationVars } from "@/lib/email";
import type { EmailTokenKey } from "@/lib/email-token-map";
import type { SpeakerEmailContext } from "@/lib/speaker-agreement";
import { getTitleLabel } from "@/lib/utils";

type TokenValues = Partial<Record<EmailTokenKey, string | number>>;

/**
 * What every audience gets: the event, the person, the sender, the typed note,
 * and the block tokens that stay empty until their own audience's builder (or
 * the sender) fills them. Not {{subject}} and {{message}}: a sender sets those
 * itself, and only for a typed email or a saved template, so a built-in
 * template that names one is still refused (an empty subject line otherwise).
 */
export function everyAudienceTokenValues(p: {
  event: { name: string; startDate: Date | null; venue: string | null; address: string | null; city: string | null; country: string | null };
  person: { id: string; firstName: string; lastName: string; title?: string | null; serialId?: number | null; ticketTypeName?: string | null };
  organizer: { name: string; email: string; signature: string | null | undefined };
  /** The note typed for this send, as typed: a sender renders it into {{personalMessage}} last. */
  note?: string | null;
  /** When the send began, so a long send gives everyone the same {{daysUntilEvent}}. */
  now?: number;
}) {
  return {
    firstName: p.person.firstName,
    lastName: p.person.lastName,
    title: getTitleLabel(p.person.title),
    speakerName: `${p.person.firstName} ${p.person.lastName}`,
    eventName: p.event.name,
    eventDate: p.event.startDate
      ? new Date(p.event.startDate).toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })
      : "TBA",
    eventVenue: p.event.venue || "TBA",
    ...eventLocationVars(p.event),
    eventAddress: p.event.address || "",
    daysUntilEvent: p.event.startDate
      ? Math.max(1, Math.ceil((new Date(p.event.startDate).getTime() - (p.now ?? Date.now())) / (1000 * 60 * 60 * 24)))
      : 1,
    organizerName: p.organizer.name,
    organizerEmail: p.organizer.email,
    organizerSignature: p.organizer.signature ?? "",
    personalMessage: p.note || "",
    ticketType: p.person.ticketTypeName || "General Admission",
    registrationId: p.person.serialId != null ? String(p.person.serialId).padStart(3, "0") : p.person.id.slice(-8).toUpperCase(),
    presentationDetails: "", presentationDetailsText: "",
    moderatorDetails: "", moderatorDetailsText: "", sessionDetails: "",
    agreementLink: "", agreementBlock: "", agreementBlockText: "", agreementAttachment: "",
    entryBarcode: "", entryBarcodeText: "", paymentBlock: "",
  } satisfies TokenValues;
}

/**
 * A speaker's own tokens, from the context every speaker email is built on
 * (buildSpeakerEmailContext). With no context (the speaker or the event could
 * not be read) the person's plain name, an empty programme and no fee, so
 * nothing is left unset; the caller logs it.
 */
export function speakerTokenValues(
  ctx: SpeakerEmailContext | null,
  person: { firstName: string; lastName: string; title?: string | null },
) {
  return {
    title: ctx?.title ?? getTitleLabel(person.title),
    speakerName: ctx?.speakerName ?? `${person.firstName} ${person.lastName}`,
    presentationDetails: ctx?.presentationDetails ?? "",
    presentationDetailsText: ctx?.presentationDetailsText ?? "",
    moderatorDetails: ctx?.moderatorDetails ?? "",
    moderatorDetailsText: ctx?.moderatorDetailsText ?? "",
    sessionDetails: ctx ? ctx.sessionTitles.replace(/\n/g, ", ") : "",
    // The organiser-agreed fee (Sep 3, 2026); "0.00" when none is agreed.
    honorarium: ctx?.honorarium ?? "0.00",
    honorariumAmount: ctx?.honorariumAmount ?? "0.00",
    honorariumCurrency: ctx?.honorariumCurrency ?? "",
  } satisfies TokenValues;
}
