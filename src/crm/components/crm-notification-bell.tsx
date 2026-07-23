"use client";

/**
 * The CRM notification bell — mounted in the CRM shell header.
 *
 * Reads the CRM's OWN feed (/api/crm/notifications → CrmNotification), which is
 * deliberately separate from the core NotificationBell in the dashboard header:
 * sponsorship-pipeline traffic never mixes into an event organizer's feed, and
 * core never imports this component (the module boundary).
 */
import { useRouter } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import {
  AlarmClock,
  Mail,
  Bell,
  CheckCheck,
  CheckSquare,
  Handshake,
  MoveRight,
  Trophy,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useCrmNotifications, useMarkCrmNotificationsRead } from "@/crm/hooks/use-crm-api";
import type { CrmNotificationRow } from "@/crm/lib/crm-types";

const typeIcons: Record<string, React.ElementType> = {
  DEAL_ASSIGNED: Handshake,
  DEAL_STAGE_MOVED: MoveRight,
  DEAL_WON: Trophy,
  DEAL_LOST: XCircle,
  TASK_ASSIGNED: CheckSquare,
  TASK_DUE: AlarmClock,
  EMAIL_RECEIVED: Mail,
};

export function CrmNotificationBell() {
  const router = useRouter();
  const { data } = useCrmNotifications();
  const markRead = useMarkCrmNotificationsRead();

  const notifications = data?.notifications ?? [];
  const unreadCount = data?.unreadCount ?? 0;

  const handleClickNotification = (n: CrmNotificationRow) => {
    if (!n.isRead) markRead.mutate({ ids: [n.id] });
    if (n.link) router.push(n.link);
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label="CRM notifications">
          <Bell className="h-5 w-5" />
          {unreadCount > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white">
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h4 className="text-sm font-semibold">CRM notifications</h4>
          {unreadCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-auto px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => markRead.mutate({ all: true })}
            >
              <CheckCheck className="mr-1 h-3 w-3" />
              Mark all read
            </Button>
          )}
        </div>

        {notifications.length === 0 ? (
          <div className="py-8 text-center">
            <Bell className="mx-auto mb-2 h-8 w-8 text-slate-300" />
            <p className="text-sm text-muted-foreground">No CRM notifications</p>
          </div>
        ) : (
          <ScrollArea className="max-h-[400px] overflow-scroll">
            <div className="divide-y">
              {notifications.map((n) => {
                const Icon = typeIcons[n.type] || Bell;
                return (
                  <button
                    key={n.id}
                    type="button"
                    onClick={() => handleClickNotification(n)}
                    className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50"
                  >
                    <div className="relative mt-0.5 shrink-0">
                      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                        <Icon className="h-4 w-4" />
                      </div>
                      {!n.isRead && (
                        <span className="absolute -left-1 -top-1 h-2.5 w-2.5 rounded-full bg-blue-500 ring-2 ring-white" />
                      )}
                    </div>

                    <div className="min-w-0 flex-1">
                      <p
                        className={`text-sm leading-snug ${
                          n.isRead ? "text-muted-foreground" : "font-medium text-foreground"
                        }`}
                      >
                        {n.title}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">{n.message}</p>
                      <p className="mt-1 text-[11px] text-muted-foreground/70">
                        {formatDistanceToNow(new Date(n.createdAt), { addSuffix: true })}
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>
          </ScrollArea>
        )}
      </PopoverContent>
    </Popover>
  );
}
