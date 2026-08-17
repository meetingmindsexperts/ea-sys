import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { sendPushToUsers } from "@/lib/push";
import {
  isNotificationEnabled,
  type NotificationSettingKey,
} from "@/lib/notification-settings";

interface CreateNotificationParams {
  userId: string;
  eventId?: string;
  type:
    | "REGISTRATION"
    | "PAYMENT"
    | "ABSTRACT"
    | "REVIEW"
    | "CHECK_IN"
    | "SIGNUP"
    | "SESSION";
  title: string;
  message: string;
  link?: string;
}

/** Send a notification to a single user (DB + push) */
export async function createNotification(params: CreateNotificationParams) {
  try {
    await db.notification.create({ data: params });

    // Fire-and-forget push notification to mobile devices
    sendPushToUsers([params.userId], {
      title: params.title,
      body: params.message,
      data: {
        type: params.type,
        ...(params.eventId ? { eventId: params.eventId } : {}),
        ...(params.link ? { link: params.link } : {}),
      },
    });
  } catch (err) {
    apiLogger.error({ err, msg: "Failed to create notification", ...params });
  }
}

/**
 * Send a notification to all admins/organizers of the event's organization
 * (DB + push).
 *
 * Pass `setting` to make the notification respect an organizer switch. The gate
 * lives HERE rather than at the call sites, so a new caller cannot forget it and
 * the switch cannot end up honoured on one path and ignored on another (there
 * are 37 call sites). A caller that passes no `setting` always sends, which is
 * why the alerts that must never be suppressible — the "⚠ Group invoice could
 * not be created" family, payment and refund events — simply omit it. Turning
 * off "new registration" notices must not silence a failed invoice.
 */
export async function notifyEventAdmins(
  eventId: string,
  params: Omit<CreateNotificationParams, "userId" | "eventId"> & {
    setting?: NotificationSettingKey;
  }
) {
  try {
    // Destructured out: `setting` is a routing hint for this function, not a
    // Notification column, and it is spread into createMany below.
    const { setting, ...notification } = params;

    const event = await db.event.findUnique({
      where: { id: eventId },
      // `settings` rides along on the lookup this function already performs,
      // so gating costs no extra query.
      select: { organizationId: true, settings: true },
    });
    if (!event) return;

    if (setting && !isNotificationEnabled(event.settings, setting)) {
      apiLogger.debug(
        { eventId, setting, title: notification.title },
        "notify:suppressed-by-event-setting",
      );
      return;
    }

    const admins = await db.user.findMany({
      where: {
        organizationId: event.organizationId,
        role: { in: ["SUPER_ADMIN", "ADMIN", "ORGANIZER"] },
      },
      select: { id: true },
    });

    if (admins.length === 0) return;

    await db.notification.createMany({
      data: admins.map((admin) => ({
        userId: admin.id,
        eventId,
        ...notification,
      })),
    });

    // Fire-and-forget push notifications to all admin mobile devices
    sendPushToUsers(
      admins.map((a) => a.id),
      {
        title: notification.title,
        body: notification.message,
        data: {
          type: notification.type,
          eventId,
          ...(notification.link ? { link: notification.link } : {}),
        },
      }
    );
  } catch (err) {
    apiLogger.error({ err, msg: "Failed to notify event admins", eventId });
  }
}
