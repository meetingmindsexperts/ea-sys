"use client";

import { useQuery } from "@tanstack/react-query";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Users, Circle } from "lucide-react";
import { cn } from "@/lib/utils";

interface ActiveUserRow {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  role: string;
  lastSeenAt: string | null;
  isOnline: boolean;
  isYou: boolean;
}

interface ActiveUsersResponse {
  users: ActiveUserRow[];
  onlineCount: number;
  onlineWindowMinutes: number;
  now: string;
}

/** "3 min ago" / "2 hours ago" / "Never". */
function formatLastSeen(iso: string | null, now: Date): string {
  if (!iso) return "Never";
  const seconds = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  return new Date(iso).toLocaleDateString(undefined, {
    day: "numeric", month: "short", year: "numeric",
  });
}

export function ActiveUsersCard() {
  const { data, isLoading, isError, refetch } = useQuery<ActiveUsersResponse>({
    queryKey: ["active-users"],
    queryFn: async () => {
      const res = await fetch("/api/organization/active-users");
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Failed to load active users");
      }
      return res.json();
    },
    // Presence is only interesting if it's current.
    refetchInterval: 30_000,
  });

  const now = data ? new Date(data.now) : new Date();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-emerald-50 text-emerald-600 dark:bg-emerald-950 dark:text-emerald-400">
            <Users className="h-4 w-4" />
          </div>
          Active Now
          {data && data.onlineCount > 0 && (
            <Badge variant="outline" className="ml-1 gap-1.5 border-emerald-200 bg-emerald-50 font-normal text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300">
              <Circle className="h-2 w-2 fill-current" />
              {data.onlineCount} online
            </Badge>
          )}
        </CardTitle>
        <CardDescription className="mt-1.5">
          Who is using the system right now, and when everyone else was last active.
          {data ? ` "Online" means active in the last ${data.onlineWindowMinutes} minutes.` : ""}
        </CardDescription>
      </CardHeader>

      <CardContent>
        {isError ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-center">
            <p className="text-sm font-medium text-destructive">Couldn&apos;t load active users.</p>
            <button
              onClick={() => refetch()}
              className="mt-2 text-sm underline underline-offset-4 hover:no-underline"
            >
              Try again
            </button>
          </div>
        ) : isLoading ? (
          <div className="py-6 text-center text-sm text-muted-foreground">Loading&hellip;</div>
        ) : !data || data.users.length === 0 ? (
          <div className="py-6 text-center text-sm text-muted-foreground">
            No team members in this organisation.
          </div>
        ) : (
          <ul className="divide-y">
            {data.users.map((u) => (
              <li key={u.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="flex min-w-0 items-center gap-2.5">
                  <Circle
                    className={cn(
                      "h-2.5 w-2.5 shrink-0",
                      u.isOnline
                        ? "fill-emerald-500 text-emerald-500"
                        : "fill-muted-foreground/25 text-muted-foreground/25",
                    )}
                  />
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">
                      {u.firstName} {u.lastName}
                      {u.isYou && <span className="ml-1.5 text-xs text-muted-foreground">(you)</span>}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">{u.email}</div>
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-3">
                  <span className="hidden text-xs text-muted-foreground sm:inline">{u.role}</span>
                  <span
                    className={cn(
                      "text-xs tabular-nums",
                      u.isOnline ? "font-medium text-emerald-600 dark:text-emerald-400" : "text-muted-foreground",
                    )}
                  >
                    {u.isOnline ? "Online" : formatLastSeen(u.lastSeenAt, now)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}

        <p className="mt-4 text-xs text-muted-foreground">
          Presence is recorded roughly every 5 minutes while someone is using the product,
          so &ldquo;last active&rdquo; is accurate to about that. Closing the browser doesn&rsquo;t
          sign anyone out &mdash; sessions last 24 hours of inactivity &mdash; so this shows who is
          <em> using</em> the system, not who has a session open.
        </p>
      </CardContent>
    </Card>
  );
}
