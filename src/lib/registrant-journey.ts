import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { computeRegistrationFinancials, readRegistrationBasePrice } from "@/lib/registration-financials";
import { isDailyMode, responseDedupKey } from "@/lib/survey/response-mode";
import { DEFAULT_CERTIFICATE_SURVEY_NAME, isLiveConfig, surveyLinkIdentifiers } from "@/services/survey-service";

/**
 * A person's journey through one event on My events (docs/MY_PORTAL_PLAN.md,
 * phase 2): Registered → Payment → Checked in → Replay → Survey → Certificate.
 *
 * Read-only, and never a second copy of a rule: payment is the event page's
 * own money math (readRegistrationBasePrice + computeRegistrationFinancials),
 * "answered" is hasAnswered's rule (survey-service.ts) applied in one batch,
 * certificates are whatever findReleasedCertificates released, and a webinar's
 * replay is registrant-replays.ts's answer.
 *
 * Each step carries its state as a WORD as well as a colour, so it reads the
 * same to someone who cannot tell green from amber.
 */

export type StepState = "done" | "action" | "waiting" | "missed";

export interface JourneyStep {
  key: "registered" | "payment" | "checkin" | "replay" | "survey" | "certificate";
  label: string;
  state: StepState;
}

export interface SurveyLine {
  /** null: the legacy certificate survey of an event with no Survey row. */
  id: string | null;
  name: string;
  answered: boolean;
  /** Answered once a day: "answered" means today. */
  daily: boolean;
  /** Still takes answers. */
  open: boolean;
  /** The certificate (CME) survey. */
  certificate: boolean;
}

/** The registration columns the journey reads. */
export const JOURNEY_REGISTRATION_FIELDS = {
  id: true,
  status: true,
  paymentStatus: true,
  groupId: true,
  attendanceMode: true,
  originalPrice: true,
  discountAmount: true,
  surveyCompletedAt: true,
  pricingTier: { select: { price: true } },
  ticketType: { select: { name: true, price: true } },
} satisfies Prisma.RegistrationSelect;

type JourneyRegistration = Prisma.RegistrationGetPayload<{ select: typeof JOURNEY_REGISTRATION_FIELDS }>;

/** Statuses that are a place at the event (not pending approval or waiting). */
const ATTENDING = new Set(["CONFIRMED", "CHECKED_IN"]);

function registeredStep(status: string): JourneyStep {
  if (status === "PENDING") return { key: "registered", label: "Awaiting approval", state: "waiting" };
  if (status === "WAITLISTED") return { key: "registered", label: "On the waiting list", state: "waiting" };
  return { key: "registered", label: "Registered", state: "done" };
}

/** Never an amount: the event page shows the money. */
export function paymentStep(reg: Omit<JourneyRegistration, "id" | "status" | "attendanceMode" | "surveyCompletedAt">): JourneyStep {
  const done = (label: string): JourneyStep => ({ key: "payment", label, state: "done" });
  if (reg.paymentStatus === "PAID") return done("Paid");
  if (reg.paymentStatus === "INCLUSIVE") return done("Sponsored");
  if (reg.paymentStatus === "REFUNDED") return done("Refunded");
  // The company pays through the group's invoice (the checkout's COVERED_BY_GROUP).
  if (reg.groupId) return done("Group invoice");
  if (reg.paymentStatus === "COMPLIMENTARY") return done("Complimentary");
  const net = computeRegistrationFinancials({
    subtotal: readRegistrationBasePrice(reg),
    discount: Number(reg.discountAmount ?? 0),
    taxRate: null,
    taxLabel: null,
    currency: "USD",
    totalPaid: 0,
  }).taxableBase;
  // Free rows are often UNPAID on production: nothing is owed on them.
  if (net === 0) return done("Free");
  return { key: "payment", label: "Payment due", state: "action" };
}

function checkInStep(status: string, endDate: Date, now: Date): JourneyStep {
  if (status === "CHECKED_IN") return { key: "checkin", label: "Checked in", state: "done" };
  if (now.getTime() <= endDate.getTime()) return { key: "checkin", label: "Check in at the event", state: "waiting" };
  return { key: "checkin", label: "Not checked in", state: "missed" };
}

function surveyStep(lines: readonly SurveyLine[]): JourneyStep {
  const answered = lines.filter((l) => l.answered).length;
  if (answered === lines.length) return { key: "survey", label: lines.length === 1 ? "Survey answered" : "Surveys answered", state: "done" };
  if (lines.length === 1) return { key: "survey", label: "Survey to answer", state: "action" };
  return { key: "survey", label: `${answered} of ${lines.length} surveys answered`, state: "action" };
}

export function buildJourney(input: {
  registration: JourneyRegistration;
  event: { endDate: Date; eventType: string | null };
  surveys: readonly SurveyLine[];
  certificateCount: number;
  /** This registration may watch the webinar's replay now (registrant-replays.ts). */
  replay?: boolean;
  now: Date;
}): JourneyStep[] {
  const { registration: reg, event, surveys, certificateCount, now } = input;
  const over = now.getTime() > event.endDate.getTime();
  const payment = paymentStep(reg);
  // Once the event is over the fee is a fact, not a to-do (review of the
  // portal, Nov 10, 2026): "Complete your payment" stayed on My events for
  // ever, and its Pay now ended in "Registration not found" because the
  // checkout only serves an event that is still open.
  const unpaidAndOver = over && payment.state === "action";
  const steps: JourneyStep[] = [registeredStep(reg.status), unpaidAndOver ? { key: "payment", label: "Not paid", state: "missed" } : payment];
  // A webinar and an online attendee never pass the desk.
  const atVenue = event.eventType !== "WEBINAR" && reg.attendanceMode !== "VIRTUAL";
  if (atVenue && ATTENDING.has(reg.status)) steps.push(checkInStep(reg.status, event.endDate, now));
  if (input.replay) steps.push({ key: "replay", label: "Replay ready", state: "done" });
  if (surveys.length > 0) steps.push(surveyStep(surveys));
  if (certificateCount > 0) {
    steps.push({ key: "certificate", label: certificateCount === 1 ? "Certificate ready" : `${certificateCount} certificates ready`, state: "done" });
  } else if (ATTENDING.has(reg.status) && over) {
    steps.push({ key: "certificate", label: "No certificate yet", state: "waiting" });
  }
  return steps;
}

// ── Surveys ───────────────────────────────────────────────────────────

export interface EventSurveyRow {
  id: string;
  eventId: string;
  name: string;
  config: unknown;
  isActive: boolean;
  gatesCertificates: boolean;
  responseMode: string;
}

export interface ResponseFact {
  surveyId: string | null;
  registrationId: string;
  dedupKey: string | null;
}

/**
 * The surveys one registration should see, each answered or not.
 *
 * An answered survey always shows. An unanswered one shows only when the
 * organiser has sent this person a link to it that is still alive (`liveLinks`,
 * the identifiers of their unexpired survey tokens): the portal re-issues
 * links, it never widens who is asked (adversarial review, Nov 9, 2026). The
 * CME survey's answer mints a certificate, so a no-show must not be offered
 * it, and an extra survey sent to one group stays with that group. It also
 * needs the survey open and the event started. Only a place at the event is
 * asked.
 */
export function surveyLinesFor(input: {
  registration: { id: string; status: string; surveyCompletedAt: Date | null };
  event: { startDate: Date; timezone: string; surveyConfig: unknown };
  surveys: readonly EventSurveyRow[];
  responses: readonly ResponseFact[];
  liveLinks: ReadonlySet<string>;
  now: Date;
}): SurveyLine[] {
  const { registration: reg, event, surveys, responses, liveLinks, now } = input;
  if (!ATTENDING.has(reg.status)) return [];
  // The certificate survey's questions and open/closed come from the Event
  // columns this release (overlayCertificateFromEvent); an event with no
  // Survey row still has it when those columns hold questions.
  const certificateLive = isLiveConfig(event.surveyConfig);
  const rows: EventSurveyRow[] = [...surveys];
  if (certificateLive && !rows.some((s) => s.gatesCertificates)) {
    rows.unshift({ id: "", eventId: "", name: DEFAULT_CERTIFICATE_SURVEY_NAME, config: event.surveyConfig, isActive: true, gatesCertificates: true, responseMode: "ONCE" });
  }
  const started = now.getTime() >= event.startDate.getTime();
  const lines: SurveyLine[] = [];
  for (const s of rows) {
    const daily = !s.gatesCertificates && isDailyMode(s.responseMode);
    const open = s.gatesCertificates ? certificateLive : s.isActive && isLiveConfig(s.config);
    let answered: boolean;
    if (s.gatesCertificates) answered = reg.surveyCompletedAt !== null;
    else if (daily) answered = responses.some((r) => r.surveyId === s.id && r.dedupKey === responseDedupKey(s.responseMode, reg.id, now, event.timezone));
    else answered = responses.some((r) => r.surveyId === s.id && r.registrationId === reg.id);
    const invited = surveyLinkIdentifiers({ id: s.id || null, gatesCertificates: s.gatesCertificates }, reg.id).some((id) => liveLinks.has(id));
    if (!answered && !(open && started && invited)) continue;
    lines.push({ id: s.id || null, name: s.name, answered, daily, open, certificate: s.gatesCertificates });
  }
  return lines;
}

/**
 * Every survey of these events, every answer these registrations gave, and
 * which of their survey links are still alive. The links are looked up by
 * their exact identifiers (one per survey a registration's event has, plus
 * the legacy CME form), so the lookup rides the identifier index.
 */
export async function loadSurveyFacts(registrations: { id: string; eventId: string }[], now: Date) {
  if (registrations.length === 0) return { surveys: [] as EventSurveyRow[], responses: [] as ResponseFact[], liveLinks: [] as string[] };
  const eventIds = [...new Set(registrations.map((r) => r.eventId))];
  const surveys = (await db.survey.findMany({
    where: { eventId: { in: eventIds } },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    select: { id: true, eventId: true, name: true, config: true, isActive: true, gatesCertificates: true, responseMode: true },
  })) as EventSurveyRow[];
  const identifiers = registrations.flatMap((r) => [
    ...surveyLinkIdentifiers(null, r.id),
    ...surveys.filter((s) => s.eventId === r.eventId).flatMap((s) => surveyLinkIdentifiers(s, r.id)),
  ]);
  const [responses, links] = await Promise.all([
    db.surveyResponse.findMany({
      where: { registrationId: { in: registrations.map((r) => r.id) } },
      select: { surveyId: true, registrationId: true, dedupKey: true },
    }),
    db.verificationToken.findMany({
      where: { identifier: { in: [...new Set(identifiers)] }, expires: { gt: now } },
      select: { identifier: true },
    }),
  ]);
  return { surveys, responses, liveLinks: links.map((l) => l.identifier) };
}
