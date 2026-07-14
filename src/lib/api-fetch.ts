/**
 * Tiny client-side fetch helpers for mutations that need to branch on
 * server error CODE / STATUS — not just message.
 *
 * Why a new helper rather than reusing `fetchApi` from `use-api.ts`:
 * the latter throws a plain `Error(message)`, which is fine for read
 * queries (they only display the message in a toast). Mutations
 * sometimes need to branch on the status + code — e.g. the
 * registration detail-sheet's PUT handler turns a 409 STALE_WRITE
 * into a refetch instead of a generic toast. So we preserve both via
 * a typed `ApiError`. Existing `fetchApi` callers are untouched.
 *
 * Usage:
 *   const update = useMutation({
 *     mutationFn: ({ id, data }) =>
 *       apiPutJson(`/api/events/${eventId}/registrations/${id}`, data),
 *     onError: (err) => {
 *       if (err instanceof ApiError && err.status === 409 && err.code === "STALE_WRITE") {
 *         // refetch path
 *       }
 *       toast.error(err.message);
 *     },
 *   });
 */

"use client";

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly data?: Record<string, unknown>;

  constructor(message: string, status: number, data?: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = typeof data?.code === "string" ? data.code : undefined;
    this.data = data;
  }
}

/**
 * Generic JSON-returning fetch wrapper. Throws an `ApiError` carrying
 * the server's `status` + `code` so onError handlers can branch on
 * them. Body parse failures on the error path fall back to an empty
 * object — never lose the throw.
 */
export async function apiFetch<T = unknown>(
  url: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const message =
      (typeof data.error === "string" && data.error) || "Request failed";
    throw new ApiError(message, res.status, data);
  }
  return (await res.json()) as T;
}

const JSON_HEADERS = { "Content-Type": "application/json" };

/**
 * POST with a JSON body. `body` is optional — when omitted, no
 * content-type header is sent (some POST routes are empty-body
 * actions like `.../check-in`).
 */
export function apiPostJson<T = unknown>(url: string, body?: unknown): Promise<T> {
  return apiFetch<T>(url, {
    method: "POST",
    ...(body !== undefined && {
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    }),
  });
}

/** PUT with a JSON body. Body is required (we don't have empty PUT routes). */
export function apiPutJson<T = unknown>(url: string, body: unknown): Promise<T> {
  return apiFetch<T>(url, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

/** PATCH with a JSON body — partial updates (the CRM's default write verb). */
export function apiPatchJson<T = unknown>(url: string, body: unknown): Promise<T> {
  return apiFetch<T>(url, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

export function apiDelete<T = unknown>(url: string): Promise<T> {
  return apiFetch<T>(url, { method: "DELETE" });
}
