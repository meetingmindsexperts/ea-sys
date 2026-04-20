import { z } from "zod";
import type { Prisma } from "@prisma/client";

/**
 * Whitelisted sort fields for the events list. Anything not in here falls
 * back to the default. Keeping this server-side-validated prevents SQL
 * injection via the Prisma orderBy object.
 */
export const EVENT_SORT_FIELDS = ["startDate", "createdAt", "name"] as const;
export type EventSortField = typeof EVENT_SORT_FIELDS[number];

export const EVENT_SORT_ORDERS = ["asc", "desc"] as const;
export type EventSortOrder = typeof EVENT_SORT_ORDERS[number];

const sortSchema = z.enum(EVENT_SORT_FIELDS);
const orderSchema = z.enum(EVENT_SORT_ORDERS);

export const DEFAULT_EVENT_SORT: { field: EventSortField; order: EventSortOrder } = {
  field: "createdAt",
  order: "desc",
};

/**
 * Parse ?sort= and ?order= query params (or server-component searchParams) into
 * a validated `{ field, order }`. Unknown values fall back to the default.
 */
export function parseEventSort(params: {
  sort?: string | string[] | undefined;
  order?: string | string[] | undefined;
}): { field: EventSortField; order: EventSortOrder } {
  const rawSort = Array.isArray(params.sort) ? params.sort[0] : params.sort;
  const rawOrder = Array.isArray(params.order) ? params.order[0] : params.order;

  const sort = sortSchema.safeParse(rawSort);
  const order = orderSchema.safeParse(rawOrder);

  return {
    field: sort.success ? sort.data : DEFAULT_EVENT_SORT.field,
    order: order.success ? order.data : DEFAULT_EVENT_SORT.order,
  };
}

/** Convert a parsed sort into a Prisma orderBy clause for the Event model. */
export function eventOrderBy(
  parsed: { field: EventSortField; order: EventSortOrder } = DEFAULT_EVENT_SORT
): Prisma.EventOrderByWithRelationInput {
  return { [parsed.field]: parsed.order } as Prisma.EventOrderByWithRelationInput;
}
