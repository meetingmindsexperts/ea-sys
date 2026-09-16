import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { getClientIp } from "@/lib/security";
import { ASSIGNABLE_USER_ROLES } from "@/lib/auth-guards";
import { isTeamRole } from "@/lib/team-roles";
import { isHrModuleEnabled, isProcurementModuleEnabled } from "@/lib/module-flags";
import { removeUserFromEventSettings } from "@/lib/event-settings";
import { approvalCeilingAed, hasAnyProcurementGrant, isFinalApproverHoldingRequestGrant, procurementGrantsFromRow } from "@/lib/procurement-visibility";

const updateUserSchema = z.object({
  firstName: z.string().min(1).max(100).optional(),
  lastName: z.string().min(1).max(100).optional(),
  // Shared with the invite route so the two doors can never disagree about
  // which roles exist (they did: MEMBER, ONSITE, CRM_USER and WEBINARS were
  // invitable but not assignable to an existing member).
  role: z.enum(ASSIGNABLE_USER_ROLES).optional(),
  /**
   * Deactivate (true) or reactivate (false) an internal user.
   *
   * A flag, not a role: the role is preserved so reactivating restores exactly
   * what they had, and every foreign key pointing at them (CRM deals, sent-email
   * attribution, audit rows) survives and stays reassignable. See
   * `User.deactivatedAt`.
   */
  deactivated: z.boolean().optional(),
  /**
   * Grant or revoke the HR module for this person (owner, Aug 31 2026).
   *
   * SUPER_ADMIN ONLY, and that restriction is the whole mechanism rather than
   * caution. HR is no longer implied by ADMIN precisely so that some admins can
   * be kept out of it; if an ADMIN could set this flag, the ones being kept out
   * could simply tick their own box and the change would be decoration. See
   * `User.hrAccess`.
   */
  hrAccess: z.boolean().optional(),
  /**
   * Budget & Procurement grants (Phase 1, Sep 14 2026). SUPER_ADMIN only for
   * the same reason as hrAccess: an approval ceiling is authority over money,
   * and an admin excluded from approving must not be able to grant it to
   * themselves. Only the fields sent are changed. `null` clears the ceiling.
   */
  procurementRequest: z.boolean().optional(),
  procurementApproveCeilingAed: z.number().positive().max(999_999_999_999).nullable().optional(),
  procurementApproveUnlimited: z.boolean().optional(),
  procurementSettle: z.boolean().optional(),
  /**
   * Who stands in for this approver after 48 hours without a decision (spec
   * §8.3). Null = the next tier. Validated below on the RESULTING row: never
   * themselves, never on the final approver (no standby, decision 9 Sep
   * 2026), and the delegate must hold approval authority of their own.
   */
  procurementDelegateUserId: z.string().min(1).max(100).nullable().optional(),
});

const PROCUREMENT_GRANT_KEYS = [
  "procurementRequest",
  "procurementApproveCeilingAed",
  "procurementApproveUnlimited",
  "procurementSettle",
  "procurementDelegateUserId",
] as const;

interface RouteParams {
  params: Promise<{ userId: string }>;
}

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const { userId } = await params;
    const session = await auth();

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const user = await db.user.findFirst({
      where: {
        id: userId,
        organizationId: session.user.organizationId!,
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        createdAt: true,
        image: true,
      },
    });

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    return NextResponse.json(user);
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error fetching user" });
    return NextResponse.json(
      { error: "Failed to fetch user" },
      { status: 500 }
    );
  }
}

export async function PUT(req: Request, { params }: RouteParams) {
  try {
    const { userId } = await params;
    const session = await auth();

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Only admins can update users (except self)
    if (session.user.role !== "ADMIN" && session.user.role !== "SUPER_ADMIN" && session.user.id !== userId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await req.json();
    const validated = updateUserSchema.safeParse(body);

    if (!validated.success) {
        apiLogger.warn({ msg: "organization/users:zod-validation-failed", errors: validated.error.flatten() });
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    // HR_USER is only grantable where the HR module is switched on. Same
    // authoritative check as the invite route: a role that can reach nothing is
    // a support ticket, and the dropdown that hides it is only UX.
    if (validated.data.role === "HR_USER" && !isHrModuleEnabled()) {
      apiLogger.warn({
        msg: "organization/users:role-not-grantable-on-this-deployment",
        role: validated.data.role,
        userId: session.user.id,
      });
      return NextResponse.json(
        { error: "That role is not available on this deployment." },
        { status: 400 },
      );
    }

    if (validated.data.hrAccess !== undefined) {
      // Only a SUPER_ADMIN decides who reads colleagues' sick leave. An ADMIN
      // being excluded from HR must not be able to re-admit themselves, which
      // is exactly what an ADMIN-writable flag would allow.
      if (session.user.role !== "SUPER_ADMIN") {
        apiLogger.warn({
          msg: "organization/users:hr-access-grant-refused",
          callerRole: session.user.role,
          callerId: session.user.id,
          targetUserId: userId,
        });
        return NextResponse.json(
          { error: "Only a super admin can change HR access." },
          { status: 403 },
        );
      }
      if (!isHrModuleEnabled()) {
        apiLogger.warn({
          msg: "organization/users:hr-access-not-available-on-this-deployment",
          targetUserId: userId,
        });
        return NextResponse.json(
          { error: "The HR module is not available on this deployment." },
          { status: 400 },
        );
      }
    }

    // Regular users can only update their own name, not role
    if (session.user.id === userId && validated.data.role && session.user.role !== "ADMIN" && session.user.role !== "SUPER_ADMIN") {
      return NextResponse.json({ error: "Cannot change your own role" }, { status: 403 });
    }

    // Deactivation is an admin action, and never a self-service one: locking
    // yourself out is not a mistake worth allowing, and the DELETE handler
    // already refuses self-deletion for the same reason.
    if (validated.data.deactivated !== undefined) {
      if (session.user.role !== "ADMIN" && session.user.role !== "SUPER_ADMIN") {
        apiLogger.warn({
          msg: "organization/users:deactivate-not-allowed",
          callerRole: session.user.role,
          userId: session.user.id,
          targetUserId: userId,
        });
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      if (session.user.id === userId) {
        apiLogger.warn({
          msg: "organization/users:deactivate-self-refused",
          userId: session.user.id,
        });
        return NextResponse.json(
          { error: "You cannot deactivate your own account", code: "CANNOT_DEACTIVATE_SELF" },
          { status: 400 },
        );
      }
    }

    const user = await db.user.findFirst({
      where: {
        id: userId,
        organizationId: session.user.organizationId!,
      },
    });

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const touchesProcurement = PROCUREMENT_GRANT_KEYS.some((k) => validated.data[k] !== undefined);
    if (touchesProcurement) {
      if (session.user.role !== "SUPER_ADMIN") {
        apiLogger.warn({
          msg: "organization/users:procurement-grant-refused",
          callerRole: session.user.role,
          callerId: session.user.id,
          targetUserId: userId,
        });
        return NextResponse.json(
          { error: "Only a super admin can change procurement grants." },
          { status: 403 },
        );
      }
      if (!isProcurementModuleEnabled()) {
        apiLogger.warn({
          msg: "organization/users:procurement-grant-not-available-on-this-deployment",
          targetUserId: userId,
        });
        return NextResponse.json(
          { error: "The Budget & Procurement module is not available on this deployment." },
          { status: 400 },
        );
      }
    }

    // Staff only, checked once the target is known. The flag would otherwise
    // work on an org-null reviewer or a registrant, who have no business in
    // there and no screen that offers it, so this keeps the reachable set equal
    // to the offered set.
    if (validated.data.hrAccess !== undefined && !isTeamRole(user.role)) {
      apiLogger.warn({
        msg: "organization/users:hr-access-non-team-target",
        targetUserId: userId,
        targetRole: user.role,
      });
      return NextResponse.json(
        { error: "HR access can only be granted to a team member." },
        { status: 400 },
      );
    }

    if (touchesProcurement && !isTeamRole(user.role)) {
      apiLogger.warn({
        msg: "organization/users:procurement-grant-non-team-target",
        targetUserId: userId,
        targetRole: user.role,
      });
      return NextResponse.json(
        { error: "Procurement grants can only be given to a team member." },
        { status: 400 },
      );
    }
    // Set when the stored delegate no longer fits and this save only carries it along.
    let clearStaleDelegate = false;
    // Spec §8.8: the final approver never requests, so requester != approver
    // can never leave a request with no approver. Judged on the RESULTING row.
    if (touchesProcurement) {
      const grants = procurementGrantsFromRow({
        procurementApproveUnlimited: validated.data.procurementApproveUnlimited ?? user.procurementApproveUnlimited,
        procurementRequest: validated.data.procurementRequest ?? user.procurementRequest,
        procurementApproveCeilingAed:
          validated.data.procurementApproveCeilingAed !== undefined ? validated.data.procurementApproveCeilingAed : user.procurementApproveCeilingAed,
        procurementSettle: validated.data.procurementSettle ?? user.procurementSettle,
      });
      if (isFinalApproverHoldingRequestGrant(grants)) {
        apiLogger.warn({
          msg: "organization/users:final-approver-cannot-request",
          targetUserId: userId,
        });
        return NextResponse.json(
          {
            error: "The final approver cannot also hold the request grant (a request from them would have no approver).",
            code: "FINAL_APPROVER_CANNOT_REQUEST",
          },
          { status: 400 },
        );
      }
      // Spec §4: the settle grant checks and signs off and never decides, so it
      // cannot sit beside an approval ceiling; the primitive refuses the pair at
      // decision time as well, this keeps the pair from being stored at all.
      if (grants.procurementSettle && approvalCeilingAed(grants) !== null) {
        apiLogger.warn({ msg: "organization/users:settle-cannot-approve", targetUserId: userId });
        return NextResponse.json(
          { error: "The settle grant cannot be held together with an approval ceiling (settle checks and signs off; it never decides).", code: "SETTLE_CANNOT_APPROVE" },
          { status: 400 },
        );
      }
      // The delegate, judged on the RESULTING row like the pairs above.
      const delegateId =
        validated.data.procurementDelegateUserId !== undefined ? validated.data.procurementDelegateUserId : user.procurementDelegateUserId;
      if (delegateId) {
        const refuse = (code: string, error: string) => {
          apiLogger.warn({ msg: "organization/users:procurement-delegate-refused", code, targetUserId: userId, delegateUserId: delegateId });
          return NextResponse.json({ error, code }, { status: 400 });
        };
        if (delegateId === userId) return refuse("DELEGATE_IS_SELF", "An approver cannot be their own delegate.");
        if (grants.procurementApproveUnlimited) {
          return refuse("FINAL_APPROVER_HAS_NO_DELEGATE", "The final approver has no delegate: a request waiting on them is reminded daily instead.");
        }
        if (approvalCeilingAed(grants) === null) {
          return refuse("DELEGATE_NEEDS_AN_APPROVER", "Only an approver has a delegate. Give this person an approval ceiling first.");
        }
        // The delegate's own side: deactivated, or no longer able to approve,
        // since they were named. Refused when this save names a new delegate;
        // when it only carries the stored one along (the grants dialog sends it
        // with every save), it is cleared instead, so a stale delegate never
        // blocks an unrelated change to this person's grants.
        const delegateChanged = delegateId !== user.procurementDelegateUserId;
        const delegate = await db.user.findFirst({
          where: { id: delegateId, organizationId: session.user.organizationId!, deactivatedAt: null },
          select: { role: true, procurementRequest: true, procurementApproveCeilingAed: true, procurementApproveUnlimited: true, procurementSettle: true },
        });
        let delegateProblem: { code: string; error: string } | null = null;
        if (!delegate || !isTeamRole(delegate.role)) {
          delegateProblem = { code: "DELEGATE_NOT_FOUND", error: "The delegate is not an active team member of this organisation." };
        } else {
          const delegateGrants = procurementGrantsFromRow(delegate);
          if (delegateGrants.procurementSettle || approvalCeilingAed(delegateGrants) === null) {
            delegateProblem = { code: "DELEGATE_CANNOT_APPROVE", error: "The delegate must hold an approval ceiling or be the final approver." };
          }
        }
        if (delegateProblem && delegateChanged) return refuse(delegateProblem.code, delegateProblem.error);
        if (delegateProblem) {
          clearStaleDelegate = true;
          apiLogger.info({ msg: "organization/users:procurement-delegate-cleared", code: delegateProblem.code, targetUserId: userId, delegateUserId: delegateId });
        }
      }
    }

    const { deactivated, ...rest } = validated.data;

    // A ROLE CHANGE CLEARS THE PER-PERSON MODULE DUTIES (owner, Sep 16 2026).
    // HR access and the four procurement grants belong to the job the person
    // held, and nothing else revokes them: a demoted admin kept authority over
    // money until a super admin happened to notice. Cleared on ANY role change,
    // promotion included, so a new role starts with none and each duty is given
    // again deliberately. Written BEFORE `...rest`, so a super admin who changes
    // the role and sets a grant in the same request still gets the grant.
    const roleChanged = !!validated.data.role && validated.data.role !== user.role;
    const heldModuleAccess =
      user.hrAccess === true || hasAnyProcurementGrant(procurementGrantsFromRow(user)) || !!user.procurementDelegateUserId;
    const clearModuleAccess = roleChanged && heldModuleAccess;
    if (clearModuleAccess) {
      apiLogger.info({
        msg: "organization/users:module-access-cleared-on-role-change",
        targetUserId: userId,
        fromRole: user.role,
        toRole: validated.data.role,
        hadHrAccess: user.hrAccess === true,
        hadProcurementGrant: hasAnyProcurementGrant(procurementGrantsFromRow(user)),
        byUserId: session.user.id,
      });
    }

    const updatedUser = await db.user.update({
      // Org-bound on the WRITE, not only on the read above — the house
      // invariant, so a future refactor that drops the lookup can't turn this
      // into a cross-org role change.
      where: { id: userId, organizationId: session.user.organizationId! },
      data: {
        ...(clearModuleAccess
          ? {
              hrAccess: false,
              procurementRequest: false,
              procurementApproveCeilingAed: null,
              procurementApproveUnlimited: false,
              procurementSettle: false,
              procurementDelegateUserId: null,
            }
          : {}),
        ...rest,
        ...(clearStaleDelegate ? { procurementDelegateUserId: null } : {}),
        // `deactivated` is the API's boolean; the column is a timestamp, so
        // the trail records WHEN, not merely that it happened.
        ...(deactivated === undefined
          ? {}
          : deactivated
            ? {
                deactivatedAt: new Date(),
                // Kill every live session immediately rather than waiting for
                // the next periodic check. Staff are re-validated on every
                // request, so this takes effect on their next click.
                tokenVersion: { increment: 1 },
              }
            : { deactivatedAt: null }),
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        hrAccess: true,
        procurementRequest: true,
        procurementApproveCeilingAed: true,
        procurementApproveUnlimited: true,
        procurementSettle: true,
        procurementDelegateUserId: true,
        deactivatedAt: true,
        createdAt: true,
      },
    });

    // Log the action
    await db.auditLog.create({
      data: {
        userId: session.user.id,
        organizationId: session.user.organizationId ?? null,
        action: "UPDATE",
        entityType: "User",
        entityId: userId,
        changes: {
          ...validated.data,
          ...(clearStaleDelegate ? { procurementDelegateUserId: null, delegateCleared: true } : {}),
          // Security-relevant like the role change itself: record that the move
          // took the person's module duties with it, and what they held.
          ...(clearModuleAccess
            ? {
                moduleAccessCleared: true,
                previousHrAccess: user.hrAccess === true,
                previousProcurementRequest: user.procurementRequest === true,
                previousProcurementSettle: user.procurementSettle === true,
                previousProcurementApproveUnlimited: user.procurementApproveUnlimited === true,
                previousProcurementCeilingAed: procurementGrantsFromRow(user).procurementApproveCeilingAed,
              }
            : {}),
          // A role change is security-relevant, so record what it was BEFORE.
          // Without this the trail says someone is now an Admin but not what
          // they were promoted from.
          ...(validated.data.role && validated.data.role !== user.role
            ? { previousRole: user.role }
            : {}),
          // Deactivation is security-relevant, so record the role they HELD
          // rather than leaving the trail to say only that a flag moved.
          ...(deactivated === undefined ? {} : { roleAtDeactivation: user.role }),
          ip: getClientIp(req),
        },
      },
    });

    return NextResponse.json(updatedUser);
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error updating user" });
    return NextResponse.json(
      { error: "Failed to update user" },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request, { params }: RouteParams) {
  try {
    const { userId } = await params;
    const session = await auth();

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Admins can delete any org user. ORGANIZER is admitted too, but ONLY to
    // delete ONSITE (registration-desk temp) accounts — enforced on the
    // fetched target below, so an organizer can't remove admins or peers.
    const callerRole = session.user.role;
    if (callerRole !== "ADMIN" && callerRole !== "SUPER_ADMIN" && callerRole !== "ORGANIZER") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Cannot delete yourself
    if (session.user.id === userId) {
      return NextResponse.json({ error: "Cannot delete yourself" }, { status: 400 });
    }

    const user = await db.user.findFirst({
      where: {
        id: userId,
        organizationId: session.user.organizationId!,
      },
    });

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    if (callerRole === "ORGANIZER" && user.role !== "ONSITE") {
      apiLogger.warn({
        msg: "organization/users:organizer-delete-not-allowed",
        targetUserId: userId,
        targetRole: user.role,
        userId: session.user.id,
      });
      return NextResponse.json(
        { error: "Organizers can only delete Onsite Staff accounts.", code: "ONSITE_ONLY" },
        { status: 403 },
      );
    }

    // Unlink any Speaker records referencing this user before deletion
    await db.speaker.updateMany({
      where: { userId },
      data: { userId: null },
    });

    // Strip per-event membership that lives in settings JSON. These are NOT
    // foreign keys, so no cascade reaches them: deleting a reviewer used to
    // leave their id in `reviewerUserIds` forever, which the Reviewers page
    // then rendered as a phantom row. Best-effort — a stale id cannot grant
    // access now that the session itself is invalidated, so this must never
    // fail the delete.
    await removeUserFromEventSettings(userId, session.user.organizationId ?? null).catch((err) =>
      apiLogger.error({
        err,
        msg: "organization/users:settings-cleanup-failed",
        targetUserId: userId,
      }),
    );

    await db.user.delete({
      where: { id: userId },
    });

    // Log the action
    await db.auditLog.create({
      data: {
        userId: session.user.id,
        organizationId: session.user.organizationId ?? null,
        action: "DELETE",
        entityType: "User",
        entityId: userId,
        changes: { email: user.email, ip: getClientIp(req) },
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error deleting user" });
    return NextResponse.json(
      { error: "Failed to delete user" },
      { status: 500 }
    );
  }
}
