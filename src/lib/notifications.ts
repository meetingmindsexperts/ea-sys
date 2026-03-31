import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";

interface CreateNotificationParams {
  userId: string;
  eventId?: string;
  type: "REGISTRATION" | "PAYMENT" | "ABSTRACT" | "REVIEW" | "CHECK_IN" | "SIGNUP";
  title: string;
  message: string;
  link?: string;
}

/** Send a notification to a single user */
export async function createNotification(params: CreateNotificationParams) {
  try {
    await db.notification.create({ data: params });
  } catch (err) {
    apiLogger.error({ err, msg: "Failed to create notification", ...params });
  }
}

/** Send a notification to all admins/organizers of the event's organization */
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
  } catch (err) {
    apiLogger.error({ err, msg: "Failed to notify event admins", eventId });
  }
}
