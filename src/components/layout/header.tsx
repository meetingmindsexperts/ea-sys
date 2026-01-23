"use client";

import { useEffect, useState } from "react";
import { signOut } from "next-auth/react";
import { useSession } from "next-auth/react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import {
  Bell,
  LogOut,
  User,
  ChevronDown,
  Calendar,
  LayoutDashboard,
  ChevronRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { formatDate } from "@/lib/utils";

interface Event {
  id: string;
  name: string;
  startDate: string;
}

export function Header() {
  const { data: session } = useSession();
  const pathname = usePathname();
  const router = useRouter();

  const [events, setEvents] = useState<Event[]>([]);
  const [currentEvent, setCurrentEvent] = useState<Event | null>(null);

  // Check if we're on an event page
  const eventMatch = pathname.match(/^\/events\/([^/]+)/);
  const eventId = eventMatch ? eventMatch[1] : null;
  const isEventPage = eventId && eventId !== "new";

  // Get the current sub-page within an event
  const subPageMatch = pathname.match(/^\/events\/[^/]+\/(.+)/);
  const currentSubPage = subPageMatch ? subPageMatch[1] : null;

  useEffect(() => {
    if (isEventPage) {
      fetchEvents();
      fetchCurrentEvent();
    }
  }, [eventId, isEventPage]);

  const fetchEvents = async () => {
    try {
      const res = await fetch("/api/events");
      if (res.ok) {
        const data = await res.json();
        setEvents(data);
      }
    } catch {
      // Silent fail
    }
  };

  const fetchCurrentEvent = async () => {
    if (!eventId) return;
    try {
      const res = await fetch(`/api/events/${eventId}`);
      if (res.ok) {
        const data = await res.json();
        setCurrentEvent(data);
      }
    } catch {
      // Silent fail
    }
  };

  const handleEventChange = (newEventId: string) => {
    if (currentSubPage) {
      router.push(`/events/${newEventId}/${currentSubPage}`);
    } else {
      router.push(`/events/${newEventId}`);
    }
  };

  const initials = session?.user
    ? `${session.user.firstName?.[0] || ""}${session.user.lastName?.[0] || ""}`
    : "U";

  return (
    <header className="flex h-16 items-center justify-between border-b bg-background px-6">
      <div className="flex items-center gap-4">
        {isEventPage && currentEvent ? (
          <div className="flex items-center gap-2">
            {/* Event Selector */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="flex items-center gap-2 h-auto py-1">
                  <Calendar className="h-4 w-4 text-muted-foreground" />
                  <span className="font-semibold">{currentEvent.name}</span>
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-64">
                <DropdownMenuLabel>Switch Event</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {events.map((event) => (
                  <DropdownMenuItem
                    key={event.id}
                    onClick={() => handleEventChange(event.id)}
                    className={event.id === eventId ? "bg-muted" : ""}
                  >
                    <Calendar className="mr-2 h-4 w-4" />
                    <div className="flex flex-col">
                      <span className="font-medium">{event.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {formatDate(event.startDate)}
                      </span>
                    </div>
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link href="/events">View All Events</Link>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Breadcrumb for sub-pages */}
            {currentSubPage && (
              <div className="flex items-center gap-2 text-muted-foreground">
                <ChevronRight className="h-4 w-4" />
                <Link
                  href={`/events/${eventId}`}
                  className="hover:text-foreground flex items-center gap-1"
                >
                  <LayoutDashboard className="h-4 w-4" />
                  Overview
                </Link>
                <ChevronRight className="h-4 w-4" />
                <span className="text-foreground capitalize">
                  {currentSubPage.split("/")[0].replace(/-/g, " ")}
                </span>
              </div>
            )}
          </div>
        ) : (
          <h1 className="text-lg font-semibold">
            {session?.user?.organizationName || "Dashboard"}
          </h1>
        )}
      </div>
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" className="relative">
          <Bell className="h-5 w-5" />
          <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-red-500" />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="flex items-center gap-2">
              <Avatar className="h-8 w-8">
                <AvatarImage src={session?.user?.image || undefined} />
                <AvatarFallback>{initials}</AvatarFallback>
              </Avatar>
              <span className="hidden md:block">
                {session?.user?.firstName} {session?.user?.lastName}
              </span>
              <ChevronDown className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>
              <div className="flex flex-col">
                <span>
                  {session?.user?.firstName} {session?.user?.lastName}
                </span>
                <span className="text-xs font-normal text-muted-foreground">
                  {session?.user?.email}
                </span>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem>
              <User className="mr-2 h-4 w-4" />
              Profile
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-red-600"
              onClick={() => signOut({ callbackUrl: "/login" })}
            >
              <LogOut className="mr-2 h-4 w-4" />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
