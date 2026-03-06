/**
 * EventsAir GraphQL API client.
 * Handles OAuth 2.0 authentication, GraphQL queries, and credential encryption.
 */

import crypto from "crypto";
import { apiLogger } from "@/lib/logger";

// ── Types ──────────────────────────────────────────────────────────

export interface EventsAirCredentials {
  clientId: string;
  clientSecret: string;
}

export interface EventsAirEvent {
  id: string;
  name: string;
  alias?: string;
  startDate: string;
  endDate: string;
  timezone?: string;
  venue?: {
    name?: string;
    city?: string;
    state?: string;
    country?: string;
  };
  isSandbox?: boolean;
  isArchived?: boolean;
}

export interface EventsAirContact {
  id: string;
  internalNumber?: string;
  firstName: string;
  lastName: string;
  primaryEmail: string;
  organizationName?: string;
  jobTitle?: string;
  website?: string;
  primaryAddress?: {
    city?: string;
    country?: string;
    phone?: string;
  };
}

// ── Credential Encryption ──────────────────────────────────────────

const ALGORITHM = "aes-256-gcm";

function deriveKey(): Buffer {
  return crypto
    .createHash("sha256")
    .update(process.env.NEXTAUTH_SECRET || "fallback-key")
    .digest();
}

export function encryptSecret(plaintext: string): string {
  const key = deriveKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");
  return `${iv.toString("hex")}:${authTag}:${encrypted}`;
}

export function decryptSecret(ciphertext: string): string {
  const parts = ciphertext.split(":");
  if (parts.length !== 3) throw new Error("Invalid encrypted format");
  const [ivHex, authTagHex, encrypted] = parts;
  const key = deriveKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

// ── OAuth 2.0 Token Management ─────────────────────────────────────

const TOKEN_ENDPOINT =
  "https://login.microsoftonline.com/dff76352-1ded-46e8-96a4-1a83718b2d3a/oauth2/v2.0/token";
const TOKEN_SCOPE =
  "https://eventsairprod.onmicrosoft.com/85d8f626-4e3d-4357-89c6-327d4e6d3d93/.default";

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(creds: EventsAirCredentials): Promise<string> {
  // Return cached token if still valid (with 60s buffer)
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.token;
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    scope: TOKEN_SCOPE,
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
  });

  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const err = await res.text();
    apiLogger.error({ msg: "EventsAir auth failed", status: res.status, error: err });
    throw new Error(`EventsAir authentication failed (${res.status})`);
  }

  const data = await res.json();
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return cachedToken.token;
}

// ── GraphQL Client ─────────────────────────────────────────────────

const GRAPHQL_ENDPOINT = "https://api.eventsair.com/graphql";

async function graphqlQuery<T>(
  creds: EventsAirCredentials,
  query: string,
  variables?: Record<string, unknown>
): Promise<T> {
  const token = await getAccessToken(creds);

  const res = await fetch(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const text = await res.text();
    apiLogger.error({ msg: "EventsAir API error", status: res.status, body: text });
    // Include response body in error for debugging
    let detail = "";
    try {
      const errJson = JSON.parse(text);
      detail = errJson.errors?.[0]?.message || errJson.message || text.slice(0, 200);
    } catch {
      detail = text.slice(0, 200);
    }
    throw new Error(`EventsAir API error (${res.status}): ${detail}`);
  }

  const json = await res.json();
  if (json.errors?.length) {
    apiLogger.error({ msg: "EventsAir GraphQL errors", errors: json.errors });
    throw new Error(json.errors[0]?.message || "GraphQL query failed");
  }

  return json.data as T;
}

// ── Public API Methods ─────────────────────────────────────────────

/** Test that the credentials are valid by obtaining a token */
export async function testConnection(creds: EventsAirCredentials): Promise<boolean> {
  try {
    await getAccessToken(creds);
    // Also verify GraphQL access
    await graphqlQuery<{ healthcheck: string }>(creds, `query { healthcheck }`);
    return true;
  } catch {
    return false;
  }
}

/** List all events accessible with these credentials (paginated, ordered by startDate desc) */
export async function listEvents(creds: EventsAirCredentials): Promise<EventsAirEvent[]> {
  const PAGE_SIZE = 2000; // Max allowed by EventsAir API
  const allEvents: EventsAirEvent[] = [];
  let offset = 0;

  // Paginate through all events
  let hasMore = true;
  while (hasMore) {
    const data = await graphqlQuery<{ events: EventsAirEvent[] }>(
      creds,
      `query($input: FindEventsInput!, $limit: PaginationLimit!, $offset: NonNegativeInt!) {
        events(input: $input, limit: $limit, offset: $offset) {
          id
          name
          alias
          startDate
          endDate
          timezone
          venue { name }
          isSandbox
          isArchived
        }
      }`,
      {
        input: {
          orderBy: { field: "START_DATE", direction: "DESCENDING" },
          where: {
            includeSandboxEvents: false,
            includeArchivedEvents: false,
          },
        },
        limit: PAGE_SIZE,
        offset,
      }
    );

    if (!data.events) {
      throw new Error("EventsAir API returned no event data — check credentials or permissions");
    }
    const events = data.events;
    allEvents.push(...events);

    // If we got fewer than PAGE_SIZE, we've fetched all events
    if (events.length < PAGE_SIZE) {
      hasMore = false;
    } else {
      offset += PAGE_SIZE;
    }
  }

  return allEvents;
}

/** Fetch detailed event info for import */
export async function fetchEventDetails(
  creds: EventsAirCredentials,
  eventId: string
): Promise<EventsAirEvent> {
  const data = await graphqlQuery<{ event: EventsAirEvent }>(
    creds,
    `query($eventId: String!) {
      event(id: $eventId) {
        id
        name
        alias
        startDate
        endDate
        timezone
        venue { name city state country }
        isSandbox
        isArchived
      }
    }`,
    { eventId }
  );
  return data.event;
}

/** Fetch contacts for an event (paginated, default batch 500) */
export async function fetchEventContacts(
  creds: EventsAirCredentials,
  eventId: string,
  offset: number = 0,
  limit: number = 500
): Promise<{ contacts: EventsAirContact[]; hasMore: boolean }> {
  const data = await graphqlQuery<{ event: { contacts: EventsAirContact[] } }>(
    creds,
    `query($eventId: String!, $offset: Int!, $limit: Int!) {
      event(id: $eventId) {
        contacts(offset: $offset, limit: $limit) {
          id
          internalNumber
          firstName
          lastName
          primaryEmail
          organizationName
          jobTitle
          website
          primaryAddress {
            city
            country
            phone
          }
        }
      }
    }`,
    { eventId, offset, limit }
  );

  const contacts = data.event?.contacts ?? [];
  return { contacts, hasMore: contacts.length === limit };
}
