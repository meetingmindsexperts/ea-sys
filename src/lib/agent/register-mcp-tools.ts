/**
 * Shared MCP tool registration — single source of truth for both
 * HTTP (mcp-server-builder.ts) and stdio (src/mcp/server.ts) transports.
 *
 * Registers ALL tools, resources, and prompts on a given McpServer instance.
 */

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PaymentStatus, RegistrationStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { TOOL_EXECUTOR_MAP, type AgentContext } from "@/lib/agent/event-tools";
import { apiLogger } from "@/lib/logger";

// ── Helpers ──────────────────────────────────────────────────────────────────

const DEFAULT_SYSTEM_USER_ID = "mcp-remote";

async function runTool(name: string, input: Record<string, unknown>, ctx: AgentContext): Promise<string> {
  const executor = TOOL_EXECUTOR_MAP[name];
  if (!executor) throw new Error(`Unknown tool: ${name}`);
  const start = Date.now();
  try {
    const result = await executor(input, ctx);
    apiLogger.info({ msg: "MCP tool call", tool: name, eventId: ctx.eventId, organizationId: ctx.organizationId, durationMs: Date.now() - start });
    return typeof result === "string" ? result : JSON.stringify(result, null, 2);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    apiLogger.error({ msg: "MCP executor throw", tool: name, eventId: ctx.eventId, organizationId: ctx.organizationId, durationMs: Date.now() - start, err: message });
    throw err;
  }
}

/**
 * Resolve orgId from eventId AND verify it matches the authenticated org.
 * Prevents cross-org data access via MCP.
 */
async function getOrgIdSecure(eventId: string, authenticatedOrgId: string): Promise<string> {
  const event = await db.event.findFirst({
    where: { id: eventId, organizationId: authenticatedOrgId },
    select: { organizationId: true },
  });
  if (!event) throw new Error(`Event ${eventId} not found or access denied`);
  return event.organizationId;
}

// ── Main registration function ───────────────────────────────────────────────

export function registerAllMcpTools(
  server: McpServer,
  organizationId: string,
  options?: { systemUserId?: string },
): void {
  const SYSTEM_USER_ID = options?.systemUserId ?? DEFAULT_SYSTEM_USER_ID;

  // Wraps every tool callback so thrown errors become MCP-protocol `isError`
  // responses with the real message instead of the SDK's generic
  // "Tool execution failed". Every failure is also logged at error level so we
  // have a server-side trace to correlate against.
  async function safeTool(
    name: string,
    run: () => Promise<string>,
  ): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: true }> {
    try {
      const text = await run();
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      apiLogger.error({ msg: "MCP tool failed", tool: name, organizationId, err: message });
      return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  }

  async function safeResource(
    name: string,
    uri: string,
    run: () => Promise<{ contents: Array<{ uri: string; text: string; mimeType?: string }> }>,
  ): Promise<{ contents: Array<{ uri: string; text: string; mimeType?: string }> }> {
    try {
      return await run();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      apiLogger.error({ msg: "MCP resource failed", name, organizationId, err: message });
      return { contents: [{ uri, text: `Error: ${message}`, mimeType: "text/plain" }] };
    }
  }

  // ── Organization-level tools ──

  server.tool(
    "list_events", "List all events in the organization.",
    {},
    async () => safeTool("list_events", async () => {
      const events = await db.event.findMany({
        where: { organizationId },
        select: {
          id: true, name: true, slug: true, status: true,
          startDate: true, endDate: true, venue: true, city: true, eventType: true,
          _count: { select: { registrations: true, speakers: true, eventSessions: true } },
        },
        orderBy: { startDate: "desc" },
      });
      return events.length === 0 ? "No events found." : events.map(e =>
        `${e.name} (${e.slug})\n  ID: ${e.id}\n  Status: ${e.status}\n  Dates: ${e.startDate.toISOString().split("T")[0]} to ${e.endDate.toISOString().split("T")[0]}\n  Registrations: ${e._count.registrations} | Speakers: ${e._count.speakers} | Sessions: ${e._count.eventSessions}`
      ).join("\n\n");
    })
  );

  server.tool(
    "create_event",
    "Create a new event in the organization. Required: name, startDate (ISO 8601), endDate (ISO 8601). Optional: slug (auto-generated from name), code (invoice-number prefix, 1-20 chars A-Z0-9-; auto-derived from name as word-initials if omitted, e.g. 'Heart Failure Forum 2026' → 'HFF2026'), description, timezone (default Asia/Dubai), venue, address, city, country, eventType (CONFERENCE/WEBINAR/HYBRID — WEBINAR auto-provisions a Zoom webinar + email sequence), tag, specialty, status (DRAFT/PUBLISHED/LIVE/COMPLETED/CANCELLED — default DRAFT).",
    {
      name: z.string().min(2).max(255),
      startDate: z.string().describe("ISO 8601 datetime string"),
      endDate: z.string().describe("ISO 8601 datetime string"),
      slug: z.string().optional(),
      code: z.string().max(20).optional(),
      description: z.string().optional(),
      timezone: z.string().optional(),
      venue: z.string().optional(),
      address: z.string().optional(),
      city: z.string().optional(),
      country: z.string().optional(),
      eventType: z.enum(["CONFERENCE", "WEBINAR", "HYBRID"]).optional(),
      tag: z.string().optional(),
      specialty: z.string().optional(),
      status: z.enum(["DRAFT", "PUBLISHED", "LIVE", "COMPLETED", "CANCELLED"]).optional(),
    },
    async (input) => safeTool("create_event", () =>
      runTool("create_event", input, {
        eventId: "",
        organizationId,
        userId: SYSTEM_USER_ID,
        counters: { creates: 0, emailsSent: 0 },
      }),
    ),
  );

  server.tool(
    "list_contacts", "Search organization contacts.",
    { search: z.string().optional(), tag: z.string().optional(), limit: z.number().optional() },
    async ({ search, tag, limit }) => safeTool("list_contacts", async () => {
      const contacts = await db.contact.findMany({
        where: {
          organizationId,
          ...(search && { OR: [
            { firstName: { contains: search, mode: "insensitive" as const } },
            { lastName: { contains: search, mode: "insensitive" as const } },
            { email: { contains: search, mode: "insensitive" as const } },
          ]}),
          ...(tag && { tags: { has: tag } }),
        },
        select: { firstName: true, lastName: true, email: true, organization: true, tags: true },
        take: Math.min(limit || 50, 200),
        orderBy: { lastName: "asc" },
      });
      return contacts.length === 0 ? "No contacts found." :
        contacts.map(c => `${c.firstName} ${c.lastName} <${c.email}>${c.organization ? ` — ${c.organization}` : ""}`).join("\n");
    })
  );

  server.tool(
    "update_contact",
    "Update a contact's details. Pass contactId and any subset of: title, firstName, lastName, organization, jobTitle, bio, specialty, phone, photo, city, state, zipCode, country, notes, tags. Email is immutable here — use the dashboard merge flow if you need to change it.",
    {
      contactId: z.string(),
      title: z.enum(["DR", "MR", "MRS", "MS", "PROF", ""]).optional(),
      firstName: z.string().optional(),
      lastName: z.string().optional(),
      organization: z.string().optional(),
      jobTitle: z.string().optional(),
      bio: z.string().optional(),
      specialty: z.string().optional(),
      phone: z.string().optional(),
      photo: z.string().nullable().optional(),
      city: z.string().optional(),
      state: z.string().optional(),
      zipCode: z.string().optional(),
      country: z.string().optional(),
      notes: z.string().optional(),
      tags: z.array(z.string()).optional(),
    },
    async (input) => safeTool("update_contact", () =>
      runTool("update_contact", input, {
        eventId: "",
        organizationId,
        userId: SYSTEM_USER_ID,
        counters: { creates: 0, emailsSent: 0 },
      }),
    ),
  );

  server.tool(
    "update_event",
    "Update an event's safe-to-change fields. Allowed: name, description, venue, address, city, country, tag, specialty, code (invoice-number prefix, 1-20 chars A-Z0-9-), taxRate (0-100), taxLabel, bankDetails, badgeVerticalOffset. EXPLICITLY REJECTS slug/startDate/endDate/eventType/timezone — those cascade to public URLs, scheduled emails, Zoom provisioning, and session times. Use the dashboard Settings page to change those.",
    {
      eventId: z.string(),
      name: z.string().optional(),
      description: z.string().nullable().optional(),
      venue: z.string().nullable().optional(),
      address: z.string().nullable().optional(),
      city: z.string().nullable().optional(),
      country: z.string().nullable().optional(),
      tag: z.string().nullable().optional(),
      specialty: z.string().nullable().optional(),
      code: z.string().max(20).nullable().optional(),
      taxRate: z.number().nullable().optional(),
      taxLabel: z.string().nullable().optional(),
      bankDetails: z.string().nullable().optional(),
      badgeVerticalOffset: z.number().optional(),
    },
    async (input) => safeTool("update_event", () =>
      runTool("update_event", input, {
        eventId: input.eventId as string,
        organizationId,
        userId: SYSTEM_USER_ID,
        counters: { creates: 0, emailsSent: 0 },
      }),
    ),
  );

  // ── Event-level read tools ──

  const readTools: Array<{ name: string; description: string; params: Record<string, z.ZodTypeAny>; agentTool?: string }> = [
    { name: "get_event_info", description: "Get event details and counts.", params: {}, agentTool: "list_event_info" },
    { name: "list_tracks", description: "List all tracks for an event.", params: {} },
    { name: "list_ticket_types", description: "List registration types and pricing.", params: {} },
    { name: "list_speakers", description: "List speakers.", params: {
      status: z.enum(["INVITED", "CONFIRMED", "DECLINED", "CANCELLED"]).optional(), limit: z.number().optional(),
    }},
    { name: "list_registrations", description: "List registrations.", params: {
      status: z.nativeEnum(RegistrationStatus).optional(),
      paymentStatus: z.nativeEnum(PaymentStatus).optional(),
      limit: z.number().optional(),
    }},
    { name: "list_sessions", description: "List sessions.", params: { trackId: z.string().optional(), limit: z.number().optional() }},
    { name: "list_abstracts", description: "List abstract submissions.", params: {
      status: z.enum(["DRAFT", "SUBMITTED", "UNDER_REVIEW", "ACCEPTED", "REJECTED", "REVISION_REQUESTED", "WITHDRAWN"]).optional(),
      themeId: z.string().optional(), limit: z.number().optional(),
    }},
    { name: "list_abstract_themes", description: "List abstract themes.", params: {} },
    { name: "list_review_criteria", description: "List review criteria.", params: {} },
    { name: "list_hotels", description: "List hotels.", params: {} },
    { name: "list_accommodations", description: "List room bookings.", params: {
      status: z.enum(["PENDING", "CONFIRMED", "CANCELLED", "CHECKED_IN", "CHECKED_OUT"]).optional(), limit: z.number().optional(),
    }},
    { name: "list_media", description: "List media files.", params: { limit: z.number().optional() }},
    { name: "list_reviewers", description: "List event reviewers.", params: {} },
    { name: "list_invoices", description: "List invoices/receipts/credit notes.", params: {
      type: z.enum(["INVOICE", "RECEIPT", "CREDIT_NOTE"]).optional(),
      status: z.enum(["DRAFT", "SENT", "PAID", "OVERDUE", "CANCELLED", "REFUNDED"]).optional(),
      limit: z.number().optional(),
    }},
    { name: "list_email_templates", description: "List email templates.", params: {} },
    { name: "get_event_stats", description: "Get event statistics dashboard.", params: {} },
    // ─── Orchestration reads ───
    { name: "get_event_dashboard", description: "Get a rich dashboard snapshot: registration counts by status + payment, speaker counts, session counts (upcoming / live now / past), check-in rate, signed/unsigned agreements, recent 5 registrations, next session.", params: {} },
    { name: "list_unpaid_registrations", description: "List registrations where paymentStatus is UNPAID/PENDING/FAILED and status is not CANCELLED. Sorted oldest first. Optional daysPending filter (only those older than N days).", params: {
      daysPending: z.number().optional(), limit: z.number().optional(),
    }},
    { name: "list_speaker_agreements", description: "List speakers with their agreement status. filter: 'unsigned' (default, who hasn't signed), 'signed' (who has), or 'all'.", params: {
      filter: z.enum(["signed", "unsigned", "all"]).optional(), limit: z.number().optional(),
    }},
    { name: "list_live_sessions_now", description: "List sessions currently live (now between startTime and endTime). Optional withinMinutes extends the window to sessions starting within N minutes.", params: {
      withinMinutes: z.number().optional(),
    }},
    { name: "search_event", description: "Case-insensitive substring search across registrations (attendee name/email/org/tags), speakers, abstracts (title + author), and contacts. Default domains = all.", params: {
      query: z.string(), domains: z.array(z.enum(["registrations", "speakers", "abstracts", "contacts"])).optional(), limit: z.number().optional(),
    }},
    // ─── Webinar + sponsor reads ───
    { name: "get_webinar_info", description: "Get webinar configuration: settings.webinar + anchor session + linked ZoomMeeting (join URL, passcode, recording status).", params: {} },
    { name: "list_webinar_attendance", description: "Webinar attendance KPIs (registered / attended / rate / avg watch time) + top N attendee rows sorted by duration.", params: {
      limit: z.number().optional(),
    }},
    { name: "list_webinar_engagement", description: "Webinar engagement: polls with per-question data + all Q&A with asker/question/answer.", params: {} },
    { name: "list_sponsors", description: "List event sponsors grouped by tier (platinum/gold/silver/bronze/partner/exhibitor).", params: {} },
    { name: "research_sponsor", description: "Fetch a sponsor's public website and propose SponsorEntry fields (name, websiteUrl, logoUrl, description). Does NOT save — review the proposal, pick a tier, then call upsert_sponsors. Tier is never inferred. Rate limited to 30/hr/user/event.", params: {
      name: z.string().optional(),
      websiteUrl: z.string().url().optional(),
    }},
    { name: "get_speaker_agreement_template", description: "Get the uploaded .docx template metadata for speaker agreement mail-merge.", params: {} },
    { name: "list_promo_codes", description: "List all promo codes for the event with usage counts, validity, and linked ticket types.", params: {} },
    { name: "list_scheduled_emails", description: "List scheduled bulk emails (PENDING/PROCESSING/SENT/FAILED/CANCELLED) with schedule time, recipient type, and send stats.", params: {} },
    // ─── Accommodation reads ───
    { name: "list_room_types", description: "List active room types for this event (or filter by hotelId). Returns capacity, price per night, and availability (totalRooms - bookedRooms).", params: {
      hotelId: z.string().optional(),
    }},
  ];

  // ── Event-level write tools ──

  const writeTools: Array<{ name: string; description: string; params: Record<string, z.ZodTypeAny>; agentTool?: string }> = [
    { name: "create_track", description: "Create a track.", params: { name: z.string(), color: z.string().optional(), description: z.string().optional() }},
    { name: "create_speaker", description: "Add a speaker.", params: {
      email: z.string(), firstName: z.string(), lastName: z.string(),
      title: z.enum(["DR", "MR", "MRS", "MS", "PROF"]).optional(),
      bio: z.string().optional(), organization: z.string().optional(), jobTitle: z.string().optional(),
      status: z.enum(["INVITED", "CONFIRMED"]).optional(),
    }},
    { name: "create_session", description: "Create a session.", params: {
      name: z.string(), startTime: z.string(), endTime: z.string(),
      trackId: z.string().optional(), location: z.string().optional(), description: z.string().optional(),
      speakerIds: z.array(z.string()).optional(),
      sessionRoles: z.array(z.object({ speakerId: z.string(), role: z.enum(["SPEAKER", "MODERATOR", "CHAIRPERSON", "PANELIST"]) })).optional(),
      topics: z.array(z.object({ title: z.string(), duration: z.number().optional(), speakerIds: z.array(z.string()).optional() })).optional(),
    }},
    { name: "add_topic_to_session", description: "Add a topic to a session.", params: {
      sessionId: z.string(), title: z.string(), duration: z.number().optional(), speakerIds: z.array(z.string()).optional(),
    }},
    { name: "create_ticket_type", description: "Create a registration type.", params: { name: z.string(), description: z.string().optional() }},
    { name: "create_registration", description: "Register an attendee.", params: {
      email: z.string(), firstName: z.string(), lastName: z.string(), ticketTypeId: z.string(),
      title: z.enum(["DR", "MR", "MRS", "MS", "PROF"]).optional(),
      organization: z.string().optional(), status: z.enum(["PENDING", "CONFIRMED", "WAITLISTED"]).optional(),
    }},
    { name: "send_bulk_email", description: "Email speakers or registrations.", params: {
      recipientType: z.enum(["speakers", "registrations"]), emailType: z.string(),
      subject: z.string(), htmlMessage: z.string(), statusFilter: z.string().optional(),
    }},
    { name: "create_abstract_theme", description: "Create an abstract theme.", params: { name: z.string() }},
    { name: "create_review_criterion", description: "Create a review criterion.", params: { name: z.string(), weight: z.number() }},
    { name: "update_abstract_status", description: "Update abstract status. ACCEPTED/REJECTED require event.settings.requiredReviewCount submissions first; set force=true to bypass (logged as chair-override).", params: {
      abstractId: z.string(), status: z.enum(["UNDER_REVIEW", "ACCEPTED", "REJECTED", "REVISION_REQUESTED"]),
      force: z.boolean().optional(),
    }},
    { name: "assign_reviewer_to_abstract", description: "Assign a reviewer to a specific abstract. Role defaults to SECONDARY. Idempotent — returns existing assignment if already assigned.", params: {
      abstractId: z.string(), userId: z.string(),
      role: z.enum(["PRIMARY", "SECONDARY", "CONSULTING"]).optional(),
      conflictFlag: z.boolean().optional(),
    }},
    { name: "unassign_reviewer_from_abstract", description: "Remove a reviewer's per-abstract assignment. Any submission the reviewer already made is preserved (abstractReviewerId is set null).", params: {
      abstractId: z.string(), userId: z.string(),
    }},
    { name: "submit_abstract_review", description: "Create or update the current reviewer's submission (upserts on abstractId+reviewerUserId). criteriaScores is a map of {criterionId: 0-10}; overallScore 0-100 auto-computed from weighted criteria if omitted. Requires an authenticated user session — NOT available via API-key MCP (returns MCP_API_KEY_NOT_SUPPORTED). Use the /my-reviews portal, the in-app AI agent, or OAuth MCP with a per-user grant.", params: {
      abstractId: z.string(),
      criteriaScores: z.record(z.string(), z.number().int().min(0).max(10)).optional(),
      overallScore: z.number().int().min(0).max(100).optional(),
      reviewNotes: z.string().optional(),
      recommendedFormat: z.enum(["ORAL", "POSTER", "NEITHER"]).optional(),
      confidence: z.number().int().min(1).max(5).optional(),
    }},
    { name: "admin_submit_review_on_behalf", description: "Org-admin: record a review on behalf of a specific human reviewer. Takes explicit reviewerUserId (the person whose scores these are). Available via API-key MCP because the attribution is explicit in the payload. Upserts on (abstractId, reviewerUserId) — same underlying row as submit_abstract_review. Audit trail flags the submission as source=mcp-on-behalf-of with actorUserId so 'X recorded by admin on behalf of Y' is traceable. The target reviewer must already be authorised for this event (in event.settings.reviewerUserIds or explicitly assigned via AbstractReviewer).", params: {
      abstractId: z.string(),
      reviewerUserId: z.string().describe("The User.id of the reviewer whose review you are recording"),
      criteriaScores: z.record(z.string(), z.number().int().min(0).max(10)).optional(),
      overallScore: z.number().int().min(0).max(100).optional(),
      reviewNotes: z.string().optional(),
      recommendedFormat: z.enum(["ORAL", "POSTER", "NEITHER"]).optional(),
      confidence: z.number().int().min(1).max(5).optional(),
    }},
    { name: "get_abstract_scores", description: "Return all reviewer submissions on an abstract plus per-criterion + overall aggregates (mean/min/max, count).", params: {
      abstractId: z.string(),
    }},
    { name: "create_hotel", description: "Add a hotel.", params: {
      name: z.string(), address: z.string().optional(), stars: z.number().optional(),
      contactEmail: z.string().optional(), contactPhone: z.string().optional(),
    }},
    { name: "check_in_registration", description: "Check in a registration.", params: { registrationId: z.string() }},
    { name: "create_contact", description: "Create a contact.", params: {
      email: z.string(), firstName: z.string(), lastName: z.string(),
      organization: z.string().optional(), jobTitle: z.string().optional(),
      phone: z.string().optional(), city: z.string().optional(), country: z.string().optional(),
      tags: z.array(z.string()).optional(),
    }},
    // ─── Actions / updates ───
    { name: "update_registration", description: "Update a registration. Top-level: status, paymentStatus, ticketTypeId, badgeType, dtcmBarcode, notes. Nested attendee: title, names, org, jobTitle, phone, city, country, bio, specialty, tags, dietaryReqs. NOTE: paymentStatus=REFUNDED only flips the DB flag — does NOT trigger a Stripe refund.", params: {
      registrationId: z.string(),
      status: z.nativeEnum(RegistrationStatus).optional(),
      paymentStatus: z.nativeEnum(PaymentStatus).optional(),
      ticketTypeId: z.string().optional(),
      badgeType: z.string().nullable().optional(),
      dtcmBarcode: z.string().nullable().optional(),
      notes: z.string().optional(),
      attendee: z.object({
        title: z.enum(["DR", "MR", "MRS", "MS", "PROF", ""]).optional(),
        firstName: z.string().optional(),
        lastName: z.string().optional(),
        organization: z.string().optional(),
        jobTitle: z.string().optional(),
        phone: z.string().optional(),
        city: z.string().optional(),
        country: z.string().optional(),
        bio: z.string().optional(),
        specialty: z.string().optional(),
        tags: z.array(z.string()).optional(),
        dietaryReqs: z.string().optional(),
      }).optional(),
    }},
    { name: "update_speaker", description: "Update a speaker's status + details. status: INVITED/CONFIRMED/DECLINED/CANCELLED. Other fields: title, names, bio, organization, jobTitle, phone, city, country, specialty, website, photo, tags.", params: {
      speakerId: z.string(),
      status: z.enum(["INVITED", "CONFIRMED", "DECLINED", "CANCELLED"]).optional(),
      title: z.enum(["DR", "MR", "MRS", "MS", "PROF", ""]).optional(),
      firstName: z.string().optional(),
      lastName: z.string().optional(),
      bio: z.string().optional(),
      organization: z.string().optional(),
      jobTitle: z.string().optional(),
      phone: z.string().optional(),
      city: z.string().optional(),
      country: z.string().optional(),
      specialty: z.string().optional(),
      website: z.string().optional(),
      photo: z.string().nullable().optional(),
      tags: z.array(z.string()).optional(),
    }},
    { name: "update_session", description: "Update a session's metadata. Validates that startTime/endTime fall within the parent event's date range. Does NOT touch topics or speakers — use add_topic_to_session for that.", params: {
      sessionId: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
      startTime: z.string().optional().describe("ISO 8601 datetime"),
      endTime: z.string().optional().describe("ISO 8601 datetime"),
      location: z.string().optional(),
      capacity: z.number().optional(),
      trackId: z.string().nullable().optional(),
      status: z.enum(["DRAFT", "SCHEDULED", "LIVE", "COMPLETED", "CANCELLED"]).optional(),
    }},
    { name: "bulk_update_registration_status", description: "Bulk-update status and/or paymentStatus on up to 200 registrations in a single transaction. Returns count of rows updated.", params: {
      registrationIds: z.array(z.string()).max(200),
      status: z.nativeEnum(RegistrationStatus).optional(),
      paymentStatus: z.nativeEnum(PaymentStatus).optional(),
    }},
    // ─── Sponsor + promo + email writes ───
    { name: "upsert_sponsors", description: "Replace the entire sponsor list for this event. Pass the full list of sponsors you want — anything missing is removed. Each sponsor needs { name, tier?, logoUrl?, websiteUrl?, description? }. URL scheme whitelist rejects javascript: and data: URLs.", params: {
      sponsors: z.array(z.object({
        id: z.string().optional(),
        name: z.string(),
        tier: z.enum(["platinum", "gold", "silver", "bronze", "partner", "exhibitor"]).optional(),
        logoUrl: z.string().optional(),
        websiteUrl: z.string().optional(),
        description: z.string().optional(),
      })),
    }},
    { name: "create_promo_code", description: "Create a discount/promo code. discountType: PERCENTAGE (value 1-100) or FIXED_AMOUNT. Optional: description, currency, maxUses, maxUsesPerEmail, validFrom, validUntil, ticketTypeIds (restricts applicability).", params: {
      code: z.string(),
      discountType: z.enum(["PERCENTAGE", "FIXED_AMOUNT"]),
      discountValue: z.number(),
      description: z.string().optional(),
      currency: z.string().optional(),
      maxUses: z.number().optional(),
      maxUsesPerEmail: z.number().optional(),
      validFrom: z.string().optional(),
      validUntil: z.string().optional(),
      isActive: z.boolean().optional(),
      ticketTypeIds: z.array(z.string()).optional(),
    }},
    { name: "update_promo_code", description: "Update a promo code. Any field can be changed. Code itself is immutable — delete and recreate if needed.", params: {
      promoCodeId: z.string(),
      description: z.string().nullable().optional(),
      discountType: z.enum(["PERCENTAGE", "FIXED_AMOUNT"]).optional(),
      discountValue: z.number().optional(),
      maxUses: z.number().nullable().optional(),
      validFrom: z.string().nullable().optional(),
      validUntil: z.string().nullable().optional(),
      isActive: z.boolean().optional(),
    }},
    { name: "delete_promo_code", description: "Soft-delete a promo code by setting isActive=false. Usage history is preserved. Hard delete is dashboard-only.", params: {
      promoCodeId: z.string(),
    }},
    { name: "cancel_scheduled_email", description: "Cancel a PENDING scheduled email. Only works on status=PENDING rows — already-sent or already-processing emails cannot be cancelled.", params: {
      scheduledEmailId: z.string(),
    }},
    // ─── Accommodation writes ───
    { name: "create_accommodation", description: "Book a room for a registration or speaker. Requires roomTypeId, checkIn, checkOut (ISO 8601). Atomic — won't overbook. Use list_room_types first to get roomTypeId + availability.", params: {
      registrationId: z.string().optional(),
      speakerId: z.string().optional(),
      roomTypeId: z.string(),
      checkIn: z.string(),
      checkOut: z.string(),
      guestCount: z.number().optional(),
      specialRequests: z.string().optional(),
    }},
    { name: "update_accommodation_status", description: "Change accommodation status: PENDING / CONFIRMED / CHECKED_IN / CHECKED_OUT / CANCELLED. Cancelling releases the room; reinstating re-checks availability.", params: {
      accommodationId: z.string(),
      status: z.enum(["PENDING", "CONFIRMED", "CHECKED_IN", "CHECKED_OUT", "CANCELLED"]),
    }},
    // ─── Invoice writes ───
    { name: "create_invoice", description: "Generate an invoice for a registration. Uses event's invoice counter for numbering. Requires event.code to be set (otherwise errors with clear message). dueDate defaults to 30 days from now. Does NOT auto-send — use send_invoice separately.", params: {
      registrationId: z.string(),
      dueDate: z.string().optional().describe("ISO 8601 datetime"),
    }},
    { name: "send_invoice", description: "Email an existing invoice PDF to the attendee. Status transitions handled internally.", params: {
      invoiceId: z.string(),
    }},
    { name: "update_invoice_status", description: "Manually set invoice status. REFUNDED flips the DB flag for book-keeping only — does NOT call Stripe. Use the dashboard for actual money movement.", params: {
      invoiceId: z.string(),
      status: z.enum(["DRAFT", "SENT", "PAID", "OVERDUE", "CANCELLED", "REFUNDED"]),
    }},
    // ─── Email template writes ───
    { name: "update_email_template", description: "Customize an event-level email template. slug examples: 'speaker-invitation', 'registration-confirmation', 'payment-reminder'. Creates an event-specific override if none exists yet. Pass any subset of subject / htmlContent / textContent.", params: {
      slug: z.string(),
      subject: z.string().optional(),
      htmlContent: z.string().optional(),
      textContent: z.string().optional(),
      name: z.string().optional(),
    }},
    { name: "reset_email_template", description: "Remove the event-specific override for an email template. Subsequent sends will use the system default.", params: {
      slug: z.string(),
    }},
    // ─── Bulk creates ───
    { name: "create_speakers_bulk", description: "Bulk-create up to 100 speakers in one call. Returns per-row { created, errors } so one bad row doesn't kill the batch. Pre-dedups by email within the payload. Each speaker needs email/firstName/lastName; optional title, bio, organization, jobTitle, phone, specialty, status (INVITED/CONFIRMED).", params: {
      speakers: z.array(z.object({
        email: z.string(),
        firstName: z.string(),
        lastName: z.string(),
        title: z.enum(["DR", "MR", "MRS", "MS", "PROF"]).optional(),
        bio: z.string().optional(),
        organization: z.string().optional(),
        jobTitle: z.string().optional(),
        phone: z.string().optional(),
        specialty: z.string().optional(),
        status: z.enum(["INVITED", "CONFIRMED"]).optional(),
      })).min(1).max(100),
    }},
    { name: "create_registrations_bulk", description: "Bulk-create up to 100 registrations in one call. Returns per-row { created, errors }. Pre-dedups by email within the payload. Each row needs email/firstName/lastName/ticketTypeId; optional title, organization, jobTitle, phone, country, specialty, status (PENDING/CONFIRMED/WAITLISTED, default CONFIRMED). Use list_ticket_types to get ticketTypeId.", params: {
      registrations: z.array(z.object({
        email: z.string(),
        firstName: z.string(),
        lastName: z.string(),
        ticketTypeId: z.string(),
        title: z.enum(["DR", "MR", "MRS", "MS", "PROF"]).optional(),
        organization: z.string().optional(),
        jobTitle: z.string().optional(),
        phone: z.string().optional(),
        country: z.string().optional(),
        specialty: z.string().optional(),
        status: z.enum(["PENDING", "CONFIRMED", "WAITLISTED"]).optional(),
      })).min(1).max(100),
    }},
  ];

  // Register all event-level tools (scoped to authenticated org)
  for (const t of [...readTools, ...writeTools]) {
    server.tool(
      t.name, t.description,
      { eventId: z.string().describe("Event ID"), ...t.params },
      async (args) => safeTool(t.name, async () => {
        const { eventId, ...input } = args;
        const orgId = await getOrgIdSecure(eventId as string, organizationId);
        return runTool(t.agentTool || t.name, input, { eventId: eventId as string, organizationId: orgId, userId: SYSTEM_USER_ID, counters: { creates: 0, emailsSent: 0 } });
      }),
    );
  }

  // ── MCP Resources ──────────────────────────────────────────────────────────

  // Static resource: all events (scoped to authenticated org)
  server.resource(
    "events-list",
    "ea-sys://events",
    { description: "List of all events in the organization" },
    async (uri) => safeResource("events-list", uri.href, async () => {
      const events = await db.event.findMany({
        where: { organizationId },
        select: { id: true, name: true, slug: true, status: true, startDate: true, endDate: true, venue: true, city: true,
          _count: { select: { registrations: true, speakers: true, eventSessions: true } } },
        orderBy: { startDate: "desc" },
      });
      return { contents: [{ uri: uri.href, text: JSON.stringify(events, null, 2), mimeType: "application/json" }] };
    })
  );

  // Template resources: per-event data
  const eventResourceTemplate = new ResourceTemplate("ea-sys://events/{eventId}/info", { list: undefined });

  server.resource(
    "event-info", eventResourceTemplate,
    { description: "Event details including name, dates, venue, status, and counts" },
    async (uri, params) => safeResource("event-info", String(uri), async () => {
      const eventId = String(params.eventId);
      const event = await db.event.findFirst({
        where: { id: eventId, organizationId },
        select: {
          id: true, name: true, slug: true, status: true, eventType: true,
          startDate: true, endDate: true, venue: true, city: true, country: true,
          _count: { select: { registrations: true, speakers: true, eventSessions: true, tracks: true, abstracts: true } },
        },
      });
      if (!event) return { contents: [{ uri: String(uri), text: "Event not found.", mimeType: "text/plain" }] };
      return { contents: [{ uri: String(uri), text: JSON.stringify(event, null, 2), mimeType: "application/json" }] };
    })
  );

  // Helper: verify eventId belongs to this org (for resources)
  async function verifyEventAccess(eventId: string): Promise<boolean> {
    const event = await db.event.findFirst({ where: { id: eventId, organizationId }, select: { id: true } });
    return !!event;
  }

  server.resource(
    "event-registrations-summary",
    new ResourceTemplate("ea-sys://events/{eventId}/registrations/summary", { list: undefined }),
    { description: "Registration counts by status and payment status" },
    async (uri, params) => safeResource("event-registrations-summary", String(uri), async () => {
      const eventId = String(params.eventId);
      if (!await verifyEventAccess(eventId)) return { contents: [{ uri: String(uri), text: "Event not found or access denied.", mimeType: "text/plain" }] };
      const [byStatus, byPayment] = await Promise.all([
        db.registration.groupBy({ by: ["status"], where: { eventId }, _count: true }),
        db.registration.groupBy({ by: ["paymentStatus"], where: { eventId }, _count: true }),
      ]);
      const data = {
        byStatus: Object.fromEntries(byStatus.map(r => [r.status, r._count])),
        byPayment: Object.fromEntries(byPayment.map(r => [r.paymentStatus, r._count])),
        total: byStatus.reduce((s, r) => s + r._count, 0),
      };
      return { contents: [{ uri: String(uri), text: JSON.stringify(data, null, 2), mimeType: "application/json" }] };
    })
  );

  server.resource(
    "event-speakers",
    new ResourceTemplate("ea-sys://events/{eventId}/speakers", { list: undefined }),
    { description: "All speakers with status" },
    async (uri, params) => safeResource("event-speakers", String(uri), async () => {
      const eventId = String(params.eventId);
      if (!await verifyEventAccess(eventId)) return { contents: [{ uri: String(uri), text: "Event not found or access denied.", mimeType: "text/plain" }] };
      const speakers = await db.speaker.findMany({
        where: { eventId },
        select: { id: true, firstName: true, lastName: true, email: true, status: true, organization: true, specialty: true },
        orderBy: { lastName: "asc" },
      });
      return { contents: [{ uri: String(uri), text: JSON.stringify(speakers, null, 2), mimeType: "application/json" }] };
    })
  );

  server.resource(
    "event-agenda",
    new ResourceTemplate("ea-sys://events/{eventId}/agenda", { list: undefined }),
    { description: "Full session agenda with tracks and speakers" },
    async (uri, params) => safeResource("event-agenda", String(uri), async () => {
      const eventId = String(params.eventId);
      if (!await verifyEventAccess(eventId)) return { contents: [{ uri: String(uri), text: "Event not found or access denied.", mimeType: "text/plain" }] };
      const sessions = await db.eventSession.findMany({
        where: { eventId },
        select: {
          id: true, name: true, startTime: true, endTime: true, location: true,
          track: { select: { name: true, color: true } },
          speakers: { select: { role: true, speaker: { select: { firstName: true, lastName: true } } } },
          topics: { select: { title: true, duration: true, speakers: { select: { speaker: { select: { firstName: true, lastName: true } } } } } },
        },
        orderBy: { startTime: "asc" },
      });
      return { contents: [{ uri: String(uri), text: JSON.stringify(sessions, null, 2), mimeType: "application/json" }] };
    })
  );

  server.resource(
    "event-abstracts-summary",
    new ResourceTemplate("ea-sys://events/{eventId}/abstracts/summary", { list: undefined }),
    { description: "Abstract counts by status and theme" },
    async (uri, params) => safeResource("event-abstracts-summary", String(uri), async () => {
      const eventId = String(params.eventId);
      if (!await verifyEventAccess(eventId)) return { contents: [{ uri: String(uri), text: "Event not found or access denied.", mimeType: "text/plain" }] };
      const [byStatus, byTheme] = await Promise.all([
        db.abstract.groupBy({ by: ["status"], where: { eventId }, _count: true }),
        db.abstract.groupBy({ by: ["themeId"], where: { eventId, themeId: { not: null } }, _count: true }),
      ]);
      const themes = byTheme.length > 0
        ? await db.abstractTheme.findMany({ where: { id: { in: byTheme.map(t => t.themeId!).filter(Boolean) } }, select: { id: true, name: true } })
        : [];
      const themeMap = new Map(themes.map(t => [t.id, t.name]));
      const data = {
        byStatus: Object.fromEntries(byStatus.map(r => [r.status, r._count])),
        byTheme: Object.fromEntries(byTheme.map(r => [themeMap.get(r.themeId!) || r.themeId, r._count])),
        total: byStatus.reduce((s, r) => s + r._count, 0),
      };
      return { contents: [{ uri: String(uri), text: JSON.stringify(data, null, 2), mimeType: "application/json" }] };
    })
  );

  // ── MCP Prompts ───────────────────────────────────────────────────────────

  server.prompt(
    "setup-event",
    "Step-by-step guide to set up a new event with tracks, registration types, and sessions.",
    { eventId: z.string().describe("Event ID") },
    async ({ eventId }) => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `I need to set up event ${eventId}. Please help me:\n1. First, get the event info to understand the current state\n2. Create tracks for organizing sessions (e.g. Keynote, Technical, Workshop)\n3. Create registration types (e.g. Delegate, VIP, Student)\n4. Create sessions with speakers assigned to tracks\n\nStart by getting the event info, then guide me through each step.`,
        },
      }],
    })
  );

  server.prompt(
    "registration-report",
    "Generate a comprehensive registration and payment report for an event.",
    { eventId: z.string().describe("Event ID") },
    async ({ eventId }) => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Generate a comprehensive registration report for event ${eventId}. Include:\n1. Total registrations by status (confirmed, pending, cancelled, waitlisted)\n2. Payment breakdown (paid, unpaid, complimentary, refunded)\n3. Registration types breakdown\n4. Check-in rate\n\nUse get_event_stats and list_registrations to gather the data, then present a clear summary.`,
        },
      }],
    })
  );

  server.prompt(
    "speaker-management",
    "Manage speakers: list, invite, and track confirmations.",
    { eventId: z.string().describe("Event ID") },
    async ({ eventId }) => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Help me manage speakers for event ${eventId}. Start by listing all speakers and their status, then help me:\n1. Identify speakers who haven't confirmed yet\n2. Draft invitation emails for new speakers\n3. Check which sessions still need speakers\n\nStart with list_speakers to see the current state.`,
        },
      }],
    })
  );

  server.prompt(
    "agenda-builder",
    "Build event agenda: create tracks, sessions, and assign speakers.",
    { eventId: z.string().describe("Event ID") },
    async ({ eventId }) => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Help me build the agenda for event ${eventId}. I need to:\n1. Review existing tracks (or create new ones)\n2. Create sessions with proper time slots\n3. Assign speakers to sessions\n4. Add topics within sessions if needed\n\nStart by getting the event info and listing existing tracks and speakers.`,
        },
      }],
    })
  );

  server.prompt(
    "abstract-review",
    "Review workflow: assign reviewers, check scores, update statuses.",
    { eventId: z.string().describe("Event ID") },
    async ({ eventId }) => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Help me manage the abstract review process for event ${eventId}. I need to:\n1. See current abstract submissions and their statuses\n2. Check review criteria and themes\n3. Review scores and make decisions (accept/reject/revision)\n\nStart by listing abstracts and review criteria to understand the current state.`,
        },
      }],
    })
  );

  server.prompt(
    "event-communications",
    "Draft and send event emails: announcements, reminders, updates.",
    { eventId: z.string().describe("Event ID") },
    async ({ eventId }) => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Help me with communications for event ${eventId}. I need to:\n1. See existing email templates\n2. Draft and send emails to registrations or speakers\n3. Target specific groups (e.g. unpaid registrations, confirmed speakers)\n\nStart by listing email templates and getting the event info.`,
        },
      }],
    })
  );

  server.prompt(
    "pre-event-checklist",
    "Pre-event readiness check: registrations, payments, agenda, speakers.",
    { eventId: z.string().describe("Event ID") },
    async ({ eventId }) => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Run a pre-event readiness check for event ${eventId}. Check:\n1. Registration numbers and any pending payments\n2. Speaker confirmations — who hasn't confirmed?\n3. Agenda completeness — any empty time slots?\n4. Abstract review status — any still under review?\n\nUse get_event_stats, list_speakers, list_sessions, and list_abstracts to gather data, then give me a readiness summary with action items.`,
        },
      }],
    })
  );
}
