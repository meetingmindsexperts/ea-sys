/**
 * Shared registration views, the write side (Sep 29, 2026;
 * docs/REGISTRATION_SHARE_PLAN.md). Errors as values; no HTTP. The routes
 * resolve the caller and the event, then call these inside runWithTenant.
 *
 * Every change is audited; switching a contact field ON is logged at warn so
 * there is a trail of who published contact details (owner ruling, the same
 * as the abstracts page).
 */
import { Prisma, type RegistrationShareLink } from "@prisma/client";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { newShareToken } from "@/lib/share-token";
import { sharePath } from "@/lib/submission-share";
import { userNames } from "@/lib/share-link-access";
import {
  LABEL_MAX,
  MAX_REGISTRATION_VIEWS,
  isViewExpired,
  registrationContactKeys,
  validateRegistrationView,
} from "@/lib/registration-share";

export interface RegistrationViewInput {
  label: string;
  enabled: boolean;
  expiresAt: Date | null;
  statuses: string[];
  fields: string[];
  ticketTypeIds: string[];
  sponsorIds: string[];
  promoCodeIds: string[];
  includeFaculty: boolean;
}

export interface RegistrationViewDto {
  id: string;
  label: string;
  enabled: boolean;
  expiresAt: string | null;
  expired: boolean;
  statuses: string[];
  fields: string[];
  ticketTypeIds: string[];
  sponsorIds: string[];
  promoCodeIds: string[];
  includeFaculty: boolean;
  path: string;
  updatedAt: string;
  updatedByName: string | null;
}

export interface RegistrationViewOptions {
  ticketTypes: { id: string; name: string }[];
  sponsors: { id: string; name: string }[];
  promoCodes: { id: string; code: string }[];
}

export type RegistrationShareErrorCode =
  | "UNKNOWN_STATUS"
  | "UNKNOWN_FIELD"
  | "NO_STATUS"
  | "INVALID_LABEL"
  | "LABEL_TAKEN"
  | "TOO_MANY_VIEWS"
  | "UNKNOWN_FILTER"
  | "EXPIRY_IN_PAST"
  | "NOT_FOUND";

type Fail = { ok: false; code: RegistrationShareErrorCode; message: string };

interface Scope {
  eventId: string;
  slug: string;
  organizationId: string;
  userId: string;
}

function toDto(link: RegistrationShareLink, slug: string, names: Map<string, string>): RegistrationViewDto {
  return {
    id: link.id,
    label: link.label,
    enabled: link.enabled,
    expiresAt: link.expiresAt?.toISOString() ?? null,
    expired: isViewExpired(link.expiresAt),
    statuses: link.statuses,
    fields: link.fields,
    ticketTypeIds: link.ticketTypeIds,
    sponsorIds: link.sponsorIds,
    promoCodeIds: link.promoCodeIds,
    includeFaculty: link.includeFaculty,
    path: sharePath(slug, link.token),
    updatedAt: link.updatedAt.toISOString(),
    updatedByName: names.get(link.updatedById) ?? null,
  };
}

export async function listRegistrationViews(eventId: string, slug: string): Promise<{ views: RegistrationViewDto[]; options: RegistrationViewOptions }> {
  const [links, ticketTypes, sponsors, promoCodes] = await Promise.all([
    db.registrationShareLink.findMany({ where: { eventId }, orderBy: { createdAt: "asc" } }),
    // Faculty is its own switch (includeFaculty), so it is not offered as a type.
    db.ticketType.findMany({ where: { eventId, isFaculty: false }, select: { id: true, name: true }, orderBy: { sortOrder: "asc" } }),
    db.sponsor.findMany({ where: { eventId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    db.promoCode.findMany({ where: { eventId }, select: { id: true, code: true }, orderBy: { code: "asc" } }),
  ]);
  const names = await userNames(links.map((l) => l.updatedById));
  return { views: links.map((l) => toDto(l, slug, names)), options: { ticketTypes, sponsors, promoCodes } };
}

/** Everything a create or update must pass before it writes. */
async function checkInput(scope: Scope, input: RegistrationViewInput, current: RegistrationShareLink | null): Promise<Fail | { ok: true; statuses: string[]; fields: string[]; label: string }> {
  const label = input.label.trim();
  if (label.length === 0 || label.length > LABEL_MAX) {
    return { ok: false, code: "INVALID_LABEL", message: `Give the view a name of 1 to ${LABEL_MAX} characters.` };
  }
  const checked = validateRegistrationView(input);
  if (!checked.ok) return checked;

  // An expiry already in the past is refused only when it is being SET, so
  // an expired view can still be edited (or have its expiry cleared).
  const expiryChanged = (input.expiresAt?.getTime() ?? null) !== (current?.expiresAt?.getTime() ?? null);
  if (expiryChanged && input.expiresAt && isViewExpired(input.expiresAt)) {
    return { ok: false, code: "EXPIRY_IN_PAST", message: "The expiry date has already passed." };
  }

  const [types, sponsors, codes, sameLabel] = await Promise.all([
    input.ticketTypeIds.length ? db.ticketType.count({ where: { eventId: scope.eventId, id: { in: input.ticketTypeIds } } }) : 0,
    input.sponsorIds.length ? db.sponsor.count({ where: { eventId: scope.eventId, id: { in: input.sponsorIds } } }) : 0,
    input.promoCodeIds.length ? db.promoCode.count({ where: { eventId: scope.eventId, id: { in: input.promoCodeIds } } }) : 0,
    db.registrationShareLink.findFirst({ where: { eventId: scope.eventId, label, ...(current && { id: { not: current.id } }) }, select: { id: true } }),
  ]);
  // A filter id from another event (or made up) is refused, never ignored:
  // ignoring it would silently WIDEN the view to every type / sponsor / code.
  if (types !== new Set(input.ticketTypeIds).size || sponsors !== new Set(input.sponsorIds).size || codes !== new Set(input.promoCodeIds).size) {
    return { ok: false, code: "UNKNOWN_FILTER", message: "A registration type, sponsor or promo code in the filter does not belong to this event." };
  }
  if (sameLabel) return { ok: false, code: "LABEL_TAKEN", message: `There is already a view called "${label}".` };
  return { ok: true, statuses: checked.statuses, fields: checked.fields, label };
}

function warnOnContact(scope: Scope, viewId: string, before: string[], after: string[]): string[] {
  const contact = registrationContactKeys();
  const shown = after.filter((f) => contact.includes(f));
  const added = shown.filter((f) => !before.includes(f));
  if (added.length > 0) {
    apiLogger.warn({ msg: "registration-shares:contact-fields-enabled", eventId: scope.eventId, viewId, userId: scope.userId, fields: added });
  }
  return shown;
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

export async function createRegistrationView(scope: Scope, input: RegistrationViewInput): Promise<{ ok: true; id: string } | Fail> {
  const count = await db.registrationShareLink.count({ where: { eventId: scope.eventId } });
  if (count >= MAX_REGISTRATION_VIEWS) {
    return { ok: false, code: "TOO_MANY_VIEWS", message: `An event can have at most ${MAX_REGISTRATION_VIEWS} shared views. Remove one first.` };
  }
  const checked = await checkInput(scope, input, null);
  if (!checked.ok) return checked;
  try {
    const link = await db.registrationShareLink.create({
      data: {
        eventId: scope.eventId,
        organizationId: scope.organizationId,
        label: checked.label,
        token: newShareToken(),
        enabled: input.enabled,
        expiresAt: input.expiresAt,
        statuses: checked.statuses,
        fields: checked.fields,
        ticketTypeIds: [...new Set(input.ticketTypeIds)],
        sponsorIds: [...new Set(input.sponsorIds)],
        promoCodeIds: [...new Set(input.promoCodeIds)],
        includeFaculty: input.includeFaculty,
        createdById: scope.userId,
        updatedById: scope.userId,
      },
    });
    const contactShown = warnOnContact(scope, link.id, [], checked.fields);
    await db.auditLog.create({
      data: {
        eventId: scope.eventId,
        organizationId: scope.organizationId,
        userId: scope.userId,
        action: "REGISTRATION_VIEW_CREATED",
        entityType: "RegistrationShareLink",
        entityId: link.id,
        changes: { label: link.label, after: auditShape(link), contactFieldsShown: contactShown, source: "rest" },
      },
    });
    apiLogger.info({ msg: "registration-shares:created", eventId: scope.eventId, viewId: link.id, userId: scope.userId });
    return { ok: true, id: link.id };
  } catch (err) {
    // Two organisers saving the same name at once: the unique index decides.
    if (isUniqueViolation(err)) return { ok: false, code: "LABEL_TAKEN", message: `There is already a view called "${checked.label}".` };
    throw err;
  }
}

function auditShape(l: Pick<RegistrationShareLink, "enabled" | "expiresAt" | "statuses" | "fields" | "ticketTypeIds" | "sponsorIds" | "promoCodeIds" | "includeFaculty">) {
  return {
    enabled: l.enabled,
    expiresAt: l.expiresAt?.toISOString() ?? null,
    statuses: l.statuses,
    fields: l.fields,
    ticketTypeIds: l.ticketTypeIds,
    sponsorIds: l.sponsorIds,
    promoCodeIds: l.promoCodeIds,
    includeFaculty: l.includeFaculty,
  };
}

export async function updateRegistrationView(scope: Scope, viewId: string, input: RegistrationViewInput): Promise<{ ok: true } | Fail> {
  const current = await db.registrationShareLink.findFirst({ where: { id: viewId, eventId: scope.eventId } });
  if (!current) return { ok: false, code: "NOT_FOUND", message: "That shared view no longer exists." };
  const checked = await checkInput(scope, input, current);
  if (!checked.ok) return checked;
  try {
    const link = await db.registrationShareLink.update({
      where: { id: current.id },
      data: {
        label: checked.label,
        enabled: input.enabled,
        expiresAt: input.expiresAt,
        statuses: checked.statuses,
        fields: checked.fields,
        ticketTypeIds: [...new Set(input.ticketTypeIds)],
        sponsorIds: [...new Set(input.sponsorIds)],
        promoCodeIds: [...new Set(input.promoCodeIds)],
        includeFaculty: input.includeFaculty,
        updatedById: scope.userId,
      },
    });
    const contactShown = warnOnContact(scope, link.id, current.fields, checked.fields);
    await db.auditLog.create({
      data: {
        eventId: scope.eventId,
        organizationId: scope.organizationId,
        userId: scope.userId,
        action: "REGISTRATION_VIEW_UPDATED",
        entityType: "RegistrationShareLink",
        entityId: link.id,
        changes: { label: link.label, before: auditShape(current), after: auditShape(link), contactFieldsShown: contactShown, source: "rest" },
      },
    });
    apiLogger.info({ msg: "registration-shares:updated", eventId: scope.eventId, viewId, userId: scope.userId });
    return { ok: true };
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, code: "LABEL_TAKEN", message: `There is already a view called "${checked.label}".` };
    throw err;
  }
}

export async function regenerateRegistrationView(scope: Scope, viewId: string): Promise<{ ok: true } | Fail> {
  const current = await db.registrationShareLink.findFirst({ where: { id: viewId, eventId: scope.eventId }, select: { id: true, label: true } });
  if (!current) return { ok: false, code: "NOT_FOUND", message: "That shared view no longer exists." };
  await db.registrationShareLink.update({ where: { id: current.id }, data: { token: newShareToken(), updatedById: scope.userId } });
  await db.auditLog.create({
    data: {
      eventId: scope.eventId,
      organizationId: scope.organizationId,
      userId: scope.userId,
      action: "REGISTRATION_VIEW_REGENERATED",
      entityType: "RegistrationShareLink",
      entityId: current.id,
      changes: { label: current.label, source: "rest" },
    },
  });
  apiLogger.info({ msg: "registration-shares:regenerated", eventId: scope.eventId, viewId, userId: scope.userId });
  return { ok: true };
}

export async function deleteRegistrationView(scope: Scope, viewId: string): Promise<{ ok: true } | Fail> {
  const current = await db.registrationShareLink.findFirst({ where: { id: viewId, eventId: scope.eventId } });
  if (!current) return { ok: false, code: "NOT_FOUND", message: "That shared view no longer exists." };
  await db.registrationShareLink.delete({ where: { id: current.id } });
  await db.auditLog.create({
    data: {
      eventId: scope.eventId,
      organizationId: scope.organizationId,
      userId: scope.userId,
      action: "REGISTRATION_VIEW_DELETED",
      entityType: "RegistrationShareLink",
      entityId: current.id,
      changes: { label: current.label, before: auditShape(current), source: "rest" },
    },
  });
  apiLogger.info({ msg: "registration-shares:deleted", eventId: scope.eventId, viewId, userId: scope.userId });
  return { ok: true };
}
