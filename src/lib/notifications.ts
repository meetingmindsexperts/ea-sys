import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { sendPushToUsers } from "@/lib/push";

interface CreateNotificationParams {
  userId: string;
  eventId?: string;
  type: "REGISTRATION" | "PAYMENT" | "ABSTRACT" | "REVIEW" | "CHECK_IN" | "SIGNUP";
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

/** Send a notification to all admins/organizers of the event's organization (DB + push) */
export async function notifyEventAdmins(
  eventId: string,
  params: Omit<CreateNotificationParams, "userId" | "eventId">
) {
  try {
    const event = await db.event.findUnique({
      where: { id: eventId },
      select: { organizationId: true },
    });
    if (!event) return;

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
        ...params,
      })),
    });

    // Fire-and-forget push notifications to all admin mobile devices
    sendPushToUsers(
      admins.map((a) => a.id),
      {
        title: params.title,
        body: params.message,
        data: {
          type: params.type,
          eventId,
          ...(params.link ? { link: params.link } : {}),
        },
      }
    );
  } catch (err) {
    apiLogger.error({ err, msg: "Failed to notify event admins", eventId });
  }
}
