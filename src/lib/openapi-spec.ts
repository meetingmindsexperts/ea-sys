/**
 * OpenAPI 3.1 spec for the EA-SYS public REST API (API-key authenticated).
 *
 * Scope: the org-scoped, API-key-accessible HTTP surface — the endpoints an
 * integrator uses to FETCH event data (events, faculty/speakers, the program,
 * registrations, registration types, contacts) and to write contacts. Create
 * for events/speakers/registrations is dashboard- or MCP-driven and is NOT
 * part of this REST surface, so it's intentionally omitted.
 *
 * Served (public, no auth — it's just the doc) at GET /api/openapi.json and
 * rendered by the Scalar viewer at /api-docs. Hand-authored against the route
 * handlers; keep in sync when those response shapes change.
 *
 * MCP (the JSON-RPC integration surface for n8n / Claude) is documented
 * separately in docs/MCP_REFERENCE.md — cross-linked from the description.
 */

// Minimal typing — we ship a plain JSON object, not a typed OpenAPI model, to
// avoid a heavy dependency. `unknown`-keyed record keeps it ergonomic.
type Json = Record<string, unknown>;

const TITLE = { type: "string", enum: ["DR", "MR", "MRS", "MS", "PROF"], nullable: true } as const;
const SPEAKER_STATUS = { type: "string", enum: ["INVITED", "CONFIRMED", "DECLINED", "CANCELLED"] } as const;

export function buildOpenApiSpec(serverUrl: string): Json {
  return {
    openapi: "3.1.0",
    info: {
      title: "EA-SYS Public API",
      version: "1.0.0",
      description: [
        "Read-focused REST API for **Meeting Minds Group / EA-SYS** events. Use it to",
        "pull event data onto your own website or systems — list events, fetch the",
        "**faculty** (speakers), build the **program** (sessions), read **registrations**,",
        "and manage your **contacts** (CRM).",
        "",
        "### Authentication",
        "Every request needs an **organization API key**. Create one in the dashboard:",
        "**Settings → API Keys**. The key is shown **once** at creation (prefix `mmg_`).",
        "Send it on every request as **either**:",
        "",
        "```",
        "x-api-key: mmg_xxxxxxxx...",
        "```",
        "or",
        "```",
        "Authorization: Bearer mmg_xxxxxxxx...",
        "```",
        "",
        "Keys are **org-scoped** — they only ever see your own organization's data.",
        "Rate limit: 100 requests/hour per key (the `Retry-After` header tells you when to retry on `429`).",
        "",
        "### Creating data",
        "Creating events, speakers, and registrations is done from the dashboard or via the",
        "**MCP integration** (for n8n / Claude / automation). Only **contacts** can be written",
        "through this REST API. MCP reference: see `docs/MCP_REFERENCE.md`.",
      ].join("\n"),
      contact: { name: "Meeting Minds Group", url: "https://www.meetingmindsgroup.com" },
    },
    servers: [{ url: serverUrl, description: "EA-SYS API" }],
    security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
    tags: [
      { name: "Events", description: "List events in your organization." },
      { name: "Faculty", description: "Speakers / faculty assigned to an event." },
      { name: "Program", description: "Sessions, tracks, topics and speaker roles — the agenda." },
      { name: "Registrations", description: "Attendee registrations for an event." },
      { name: "Reference", description: "Registration-type names." },
      { name: "Contacts", description: "Organization contact store (CRM)." },
    ],
    paths: {
      "/api/events": {
        get: {
          tags: ["Events"],
          summary: "List events",
          description: "All events in your organization, newest first. Use an event's `id` for the event-scoped endpoints below.",
          parameters: [
            { name: "slug", in: "query", required: false, schema: { type: "string" }, description: "Filter to a single event by its public slug." },
            { name: "sort", in: "query", required: false, schema: { type: "string", enum: ["eventName", "startDate", "registrations", "speakers"] } },
            { name: "order", in: "query", required: false, schema: { type: "string", enum: ["asc", "desc"] } },
          ],
          responses: {
            "200": { description: "Array of events", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Event" } } } } },
            "401": { $ref: "#/components/responses/Unauthorized" },
          },
        },
      },
      "/api/events/{eventId}/speakers": {
        get: {
          tags: ["Faculty"],
          summary: "List faculty (speakers)",
          description: "Speakers assigned to an event — names, titles, bios, photos, organization, session/abstract counts. Ideal for a 'Faculty' page on your website.",
          parameters: [
            { name: "eventId", in: "path", required: true, schema: { type: "string" } },
            { name: "status", in: "query", required: false, schema: { ...SPEAKER_STATUS }, description: "Filter by speaker status." },
          ],
          responses: {
            "200": { description: "Array of speakers", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Speaker" } } } } },
            "401": { $ref: "#/components/responses/Unauthorized" },
            "404": { $ref: "#/components/responses/NotFound" },
          },
        },
      },
      "/api/events/{eventId}/sessions": {
        get: {
          tags: ["Program"],
          summary: "List the program (sessions)",
          description: "Build the agenda/program: sessions with start/end times, location, track, speaker roles (Speaker/Moderator/Chairperson/Panelist), and per-session topics. Filter by track, status, or day.",
          parameters: [
            { name: "eventId", in: "path", required: true, schema: { type: "string" } },
            { name: "trackId", in: "query", required: false, schema: { type: "string" } },
            { name: "status", in: "query", required: false, schema: { type: "string", enum: ["DRAFT", "SCHEDULED", "LIVE", "COMPLETED", "CANCELLED"] } },
            { name: "date", in: "query", required: false, schema: { type: "string", format: "date" }, description: "Only sessions starting on this calendar day (YYYY-MM-DD)." },
          ],
          responses: {
            "200": { description: "Array of sessions", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Session" } } } } },
            "401": { $ref: "#/components/responses/Unauthorized" },
            "404": { $ref: "#/components/responses/NotFound" },
          },
        },
      },
      "/api/events/{eventId}/registrations": {
        get: {
          tags: ["Registrations"],
          summary: "List registrations",
          description: "Attendee registrations with attendee details, ticket type, payment status, and attendance mode. Paginated.",
          parameters: [
            { name: "eventId", in: "path", required: true, schema: { type: "string" } },
            { name: "status", in: "query", required: false, schema: { type: "string", enum: ["PENDING", "CONFIRMED", "CANCELLED", "WAITLISTED", "CHECKED_IN"] } },
            { name: "paymentStatus", in: "query", required: false, schema: { type: "string", enum: ["UNPAID", "PENDING", "PAID", "COMPLIMENTARY", "REFUNDED", "FAILED", "UNASSIGNED", "INCLUSIVE"] } },
            { name: "ticketTypeId", in: "query", required: false, schema: { type: "string" } },
            { name: "tags", in: "query", required: false, schema: { type: "string" }, description: "Comma-separated tag names (OR match)." },
            { name: "page", in: "query", required: false, schema: { type: "integer", default: 1, minimum: 1 } },
            { name: "limit", in: "query", required: false, schema: { type: "integer", default: 50, minimum: 1, maximum: 100 } },
          ],
          responses: {
            "200": { description: "Array of registrations", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Registration" } } } } },
            "401": { $ref: "#/components/responses/Unauthorized" },
            "404": { $ref: "#/components/responses/NotFound" },
          },
        },
      },
      "/api/registration-types": {
        get: {
          tags: ["Reference"],
          summary: "List registration-type names",
          description: "Distinct ticket-type names across your organization (e.g. \"Physician\", \"Allied Health\").",
          responses: {
            "200": { description: "Array of names", content: { "application/json": { schema: { type: "array", items: { type: "string" } } } } },
            "401": { $ref: "#/components/responses/Unauthorized" },
          },
        },
      },
      "/api/contacts": {
        get: {
          tags: ["Contacts"],
          summary: "List contacts",
          description: "Your organization's contact store (CRM), paginated. Search by name/email/organization or filter by tags.",
          parameters: [
            { name: "search", in: "query", required: false, schema: { type: "string" } },
            { name: "tags", in: "query", required: false, schema: { type: "string" }, description: "Comma-separated tag names (OR match)." },
            { name: "page", in: "query", required: false, schema: { type: "integer", default: 1, minimum: 1 } },
            { name: "limit", in: "query", required: false, schema: { type: "integer", default: 50, minimum: 1, maximum: 100 } },
          ],
          responses: {
            "200": { description: "Paginated contacts", content: { "application/json": { schema: { $ref: "#/components/schemas/ContactList" } } } },
            "401": { $ref: "#/components/responses/Unauthorized" },
          },
        },
        post: {
          tags: ["Contacts"],
          summary: "Create a contact",
          description: "Add a contact to the org CRM. Rate limited to 50/hour per organization.",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/ContactCreate" } } },
          },
          responses: {
            "201": { description: "Created contact", content: { "application/json": { schema: { $ref: "#/components/schemas/Contact" } } } },
            "400": { $ref: "#/components/responses/BadRequest" },
            "401": { $ref: "#/components/responses/Unauthorized" },
            "409": { description: "A contact with this email already exists", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
            "429": { $ref: "#/components/responses/RateLimited" },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        ApiKeyAuth: { type: "apiKey", in: "header", name: "x-api-key", description: "Organization API key (prefix `mmg_`)." },
        BearerAuth: { type: "http", scheme: "bearer", description: "Same `mmg_` key sent as a Bearer token." },
      },
      responses: {
        Unauthorized: { description: "Missing or invalid API key", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" }, example: { error: "Unauthorized" } } } },
        NotFound: { description: "Event not found (or not in your organization)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" }, example: { error: "Event not found" } } } },
        BadRequest: { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" }, example: { error: "Invalid input", details: { fieldErrors: { email: ["Valid email is required"] } } } } } },
        RateLimited: { description: "Rate limit exceeded — see Retry-After", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" }, example: { error: "Contact creation limit reached. Maximum 50 per hour." } } } },
      },
      schemas: {
        Error: {
          type: "object",
          properties: {
            error: { type: "string" },
            code: { type: "string", nullable: true },
            details: { type: "object", nullable: true, additionalProperties: true },
          },
          required: ["error"],
        },
        Event: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            slug: { type: "string" },
            description: { type: "string", nullable: true },
            startDate: { type: "string", format: "date-time" },
            endDate: { type: "string", format: "date-time" },
            timezone: { type: "string", example: "Asia/Dubai" },
            venue: { type: "string", nullable: true },
            address: { type: "string", nullable: true },
            city: { type: "string", nullable: true },
            country: { type: "string", nullable: true },
            eventType: { type: "string", enum: ["CONFERENCE", "WEBINAR", "HYBRID"], nullable: true },
            tag: { type: "string", nullable: true },
            specialty: { type: "string", nullable: true },
            code: { type: "string", nullable: true },
            status: { type: "string", enum: ["DRAFT", "PUBLISHED", "LIVE", "COMPLETED", "CANCELLED"] },
            _count: { type: "object", properties: { registrations: { type: "integer" }, speakers: { type: "integer" } } },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
        Speaker: {
          type: "object",
          properties: {
            id: { type: "string" },
            eventId: { type: "string" },
            title: TITLE,
            firstName: { type: "string" },
            lastName: { type: "string" },
            email: { type: "string", format: "email" },
            additionalEmail: { type: "string", nullable: true },
            bio: { type: "string", nullable: true },
            organization: { type: "string", nullable: true },
            jobTitle: { type: "string", nullable: true },
            phone: { type: "string", nullable: true },
            website: { type: "string", nullable: true },
            photo: { type: "string", nullable: true, description: "Relative path, e.g. /uploads/photos/...; prefix with the API base." },
            city: { type: "string", nullable: true },
            country: { type: "string", nullable: true },
            specialty: { type: "string", nullable: true },
            registrationType: { type: "string", nullable: true },
            tags: { type: "array", items: { type: "string" } },
            socialLinks: { type: "object", additionalProperties: { type: "string" } },
            status: SPEAKER_STATUS,
            _count: { type: "object", properties: { sessions: { type: "integer" }, abstracts: { type: "integer" } } },
          },
        },
        Session: {
          type: "object",
          description: "A program session.",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            description: { type: "string", nullable: true },
            startTime: { type: "string", format: "date-time" },
            endTime: { type: "string", format: "date-time" },
            location: { type: "string", nullable: true },
            capacity: { type: "integer", nullable: true },
            status: { type: "string", enum: ["DRAFT", "SCHEDULED", "LIVE", "COMPLETED", "CANCELLED"] },
            track: { type: "object", nullable: true, properties: { id: { type: "string" }, name: { type: "string" }, color: { type: "string" } } },
            speakers: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  role: { type: "string", enum: ["SPEAKER", "MODERATOR", "CHAIRPERSON", "PANELIST"] },
                  speaker: { type: "object", properties: { id: { type: "string" }, title: TITLE, firstName: { type: "string" }, lastName: { type: "string" }, status: SPEAKER_STATUS } },
                },
              },
            },
            topics: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  title: { type: "string" },
                  sortOrder: { type: "integer" },
                  duration: { type: "integer", nullable: true },
                  speakers: { type: "array", items: { type: "object", properties: { speaker: { type: "object", properties: { id: { type: "string" }, firstName: { type: "string" }, lastName: { type: "string" } } } } } },
                },
              },
            },
          },
        },
        Registration: {
          type: "object",
          properties: {
            id: { type: "string" },
            eventId: { type: "string" },
            serialId: { type: "integer", nullable: true },
            status: { type: "string", enum: ["PENDING", "CONFIRMED", "CANCELLED", "WAITLISTED", "CHECKED_IN"] },
            paymentStatus: { type: "string", enum: ["UNPAID", "PENDING", "PAID", "COMPLIMENTARY", "REFUNDED", "FAILED", "UNASSIGNED", "INCLUSIVE"] },
            attendanceMode: { type: "string", enum: ["IN_PERSON", "VIRTUAL"] },
            checkedInAt: { type: "string", format: "date-time", nullable: true },
            createdAt: { type: "string", format: "date-time" },
            attendee: {
              type: "object",
              properties: {
                firstName: { type: "string" },
                lastName: { type: "string" },
                email: { type: "string", format: "email" },
                title: TITLE,
                phone: { type: "string", nullable: true },
                organization: { type: "string", nullable: true },
                jobTitle: { type: "string", nullable: true },
                city: { type: "string", nullable: true },
                country: { type: "string", nullable: true },
                specialty: { type: "string", nullable: true },
                tags: { type: "array", items: { type: "string" } },
              },
            },
            ticketType: { type: "object", nullable: true, properties: { id: { type: "string" }, name: { type: "string" }, price: { type: "string", description: "Decimal as string" }, currency: { type: "string" } } },
          },
        },
        Contact: {
          type: "object",
          properties: {
            id: { type: "string" },
            title: TITLE,
            firstName: { type: "string" },
            lastName: { type: "string" },
            email: { type: "string", format: "email" },
            organization: { type: "string", nullable: true },
            jobTitle: { type: "string", nullable: true },
            specialty: { type: "string", nullable: true },
            phone: { type: "string", nullable: true },
            tags: { type: "array", items: { type: "string" } },
            createdAt: { type: "string", format: "date-time" },
          },
        },
        ContactList: {
          type: "object",
          properties: {
            contacts: { type: "array", items: { $ref: "#/components/schemas/Contact" } },
            total: { type: "integer" },
            page: { type: "integer" },
            totalPages: { type: "integer" },
          },
        },
        ContactCreate: {
          type: "object",
          required: ["email", "firstName", "lastName"],
          properties: {
            title: { type: "string", enum: ["DR", "MR", "MRS", "MS", "PROF"] },
            email: { type: "string", format: "email", maxLength: 255 },
            firstName: { type: "string", minLength: 1, maxLength: 100 },
            lastName: { type: "string", minLength: 1, maxLength: 100 },
            organization: { type: "string", maxLength: 255 },
            jobTitle: { type: "string", maxLength: 255 },
            specialty: { type: "string", maxLength: 255 },
            phone: { type: "string", maxLength: 50 },
            city: { type: "string", maxLength: 255 },
            country: { type: "string", maxLength: 255 },
            tags: { type: "array", items: { type: "string", maxLength: 100 } },
            notes: { type: "string", maxLength: 2000 },
          },
        },
      },
    },
  };
}
