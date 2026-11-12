"use client";

import { useState } from "react";
import { signOut } from "next-auth/react";
import { useSession } from "next-auth/react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import {
  LogOut,
  User,
  ChevronDown,
  Calendar,
  LayoutDashboard,
  ChevronRight,
  Shield,
  ShieldCheck,
  Eye,
  FileText,
  Check,
  X,
  Ticket,
  ScanBarcode,
  Video,
  Handshake,
  CalendarClock,
  KeyRound,
  UserRound,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { signOutCallbackUrl } from "@/lib/sign-out-target";
import { isTeamRole, receivesEventNotifications } from "@/lib/team-roles";
import { useEvents, useEvent } from "@/hooks/use-api";
import { NotificationBell } from "@/components/notifications/notification-bell";
import { MobileSidebar } from "@/components/layout/sidebar";
import { EventSwitcher } from "@/components/layout/event-switcher";

// ── Role metadata ─────────────────────────────────────────────────────────────

type RoleMeta = {
  label: string;
  description: string;
  color: string; // bg + text classes
  icon: React.ElementType;
  permissions: { label: string; allowed: boolean }[];
};

const ROLE_META: Record<string, RoleMeta> = {
  SUPER_ADMIN: {
    label: "Super Admin",
    description: "Full platform access",
    color: "bg-violet-100 text-violet-700",
    icon: ShieldCheck,
    permissions: [
      { label: "Manage events & team",     allowed: true },
      { label: "Review & approve abstracts", allowed: true },
      { label: "Delete abstracts",          allowed: true },
      { label: "Organisation settings",    allowed: true },
    ],
  },
  ADMIN: {
    label: "Admin",
    description: "Event management & reviews",
    color: "bg-blue-100 text-blue-700",
    icon: Shield,
    permissions: [
      { label: "Manage events & team",     allowed: true },
      { label: "Review & approve abstracts", allowed: true },
      { label: "Delete abstracts",          allowed: false },
      { label: "Organisation settings",    allowed: true },
    ],
  },
  ORGANIZER: {
    label: "Organizer",
    description: "Event operations",
    color: "bg-emerald-100 text-emerald-700",
    icon: Calendar,
    permissions: [
      { label: "Manage events",            allowed: true },
      { label: "Review & approve abstracts", allowed: false },
      { label: "Delete abstracts",          allowed: false },
      { label: "Organisation settings",    allowed: false },
    ],
  },
  REVIEWER: {
    label: "Reviewer",
    description: "Abstract review",
    color: "bg-amber-100 text-amber-700",
    icon: Eye,
    permissions: [
      { label: "View assigned events",      allowed: true },
      { label: "Review & score abstracts",  allowed: true },
      { label: "Accept/reject abstracts",   allowed: true },
      { label: "Manage events",             allowed: false },
    ],
  },
  SUBMITTER: {
    label: "Submitter",
    description: "Abstract submissions",
    color: "bg-gray-100 text-gray-700",
    icon: FileText,
    permissions: [
      { label: "Submit abstracts",         allowed: true },
      { label: "Edit own abstracts",       allowed: true },
      { label: "Review & approve abstracts", allowed: false },
      { label: "Delete abstracts",          allowed: false },
    ],
  },
  REGISTRANT: {
    label: "Registrant",
    description: "Registration management",
    color: "bg-teal-100 text-teal-700",
    icon: Ticket,
    permissions: [
      { label: "View own registration",   allowed: true },
      { label: "Edit personal details",   allowed: true },
      { label: "Make payment",            allowed: true },
      { label: "Manage events",           allowed: false },
    ],
  },
  ONSITE: {
    label: "Onsite Staff",
    description: "Registration & check-in",
    color: "bg-cyan-100 text-cyan-700",
    icon: ScanBarcode,
    permissions: [
      { label: "Add registrations",        allowed: true },
      { label: "Check attendees in",       allowed: true },
      { label: "Print badges",             allowed: true },
      { label: "View prices & payments",   allowed: false },
    ],
  },
  WEBINARS: {
    label: "Webinars",
    description: "Webinar team",
    color: "bg-violet-100 text-violet-700",
    icon: Video,
    permissions: [
      { label: "Run webinar events",        allowed: true },
      { label: "Registration desk (assigned)", allowed: true },
      { label: "Manage conferences",        allowed: false },
      { label: "Organization settings",     allowed: false },
    ],
  },
  CRM_USER: {
    label: "CRM User",
    description: "Sales pipeline",
    color: "bg-green-100 text-green-700",
    icon: Handshake,
    permissions: [
      { label: "Work the sales pipeline",  allowed: true },
      { label: "See deal values",          allowed: true },
      { label: "Manage events",            allowed: false },
      { label: "See event finances",       allowed: false },
    ],
  },

  HR_USER: {
    label: "HR User",
    description: "Attendance and leave",
    color: "bg-rose-100 text-rose-700",
    icon: CalendarClock,
    permissions: [
      { label: "Record attendance",     allowed: true },
      { label: "Manage leave balances", allowed: true },
      { label: "Manage events",         allowed: false },
      { label: "See event finances",    allowed: false },
    ],
  },

  // No default permissions: what the person can do is whatever their custom
  // roles add (docs/BASE_ROLE_PLAN.md), so the list says only that.
  BASE: {
    label: "Base role",
    description: "Access from custom roles",
    color: "bg-slate-100 text-slate-700",
    icon: KeyRound,
    // One row: a custom role may grant anything outside Budgets, CRM and HR,
    // so a fixed "no" here could be wrong (review, Oct 23, 2026).
    permissions: [{ label: "What your custom roles add", allowed: true }],
  },
};

// ── Component ─────────────────────────────────────────────────────────────────

const EXTRA_ROLE_LABELS: Record<string, string> = { MEMBER: "Member" };

/** Header title when the user has no organisation name to show. */
function portalTitle(role: string): string {
  // One person can review on one event and submit to another, so the portal is
  // not named after the account's role. What it holds comes from the sidebar.
  if (role === "REVIEWER" || role === "SUBMITTER" || role === "REGISTRANT") return "My portal";
  if (role === "CRM_USER") return "CRM";
  if (role === "HR_USER") return "HR";
  return "Dashboard";
}

/** The display name of a role, as the header badge shows it ("Onsite Staff"). */
export function roleLabelOf(role: string | null | undefined): string | null {
  if (!role) return null;
  // MEMBER carries no header badge, so it has no ROLE_META entry.
  return ROLE_META[role]?.label ?? EXTRA_ROLE_LABELS[role] ?? null;
}

export function Header() {
  const { data: session } = useSession();
  const pathname = usePathname();
  const router = useRouter();

  const eventMatch = pathname.match(/^\/events\/([^/]+)/);
  const eventId = eventMatch ? eventMatch[1] : null;
  const isEventPage = eventId && eventId !== "new";

  const subPageMatch = pathname.match(/^\/events\/[^/]+\/(.+)/);
  const currentSubPage = subPageMatch ? subPageMatch[1] : null;

  const { data: events = [] } = useEvents();
  const { data: currentEvent } = useEvent(isEventPage ? eventId! : "");

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

  // Sign out asks first (owner, Sep 16 2026). The dialog is a SIBLING of the
  // dropdown, never a child: a menu unmounts the moment an item is clicked and
  // would take a nested dialog with it, which is the same portal trap that made
  // a Radix Select inside a popover silently do nothing (no error, no request).
  const [confirmSignOut, setConfirmSignOut] = useState(false);

  const role = session?.user?.role ?? "ORGANIZER";
  const roleMeta = ROLE_META[role] ?? ROLE_META.ORGANIZER;
  const RoleIcon = roleMeta.icon;

  return (
    <header className="relative flex h-16 items-center justify-between gap-2 border-b bg-background px-4 md:px-6">
      <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-gradient-primary-horizontal opacity-50" />

      {/* ── Left: phone menu, then event selector / breadcrumb ────────────── */}
      <div className="flex min-w-0 items-center gap-2 md:gap-4">
        <MobileSidebar />
        {isEventPage && currentEvent ? (
          <div className="flex min-w-0 items-center gap-2">
            <EventSwitcher
              currentEventId={eventId!}
              currentEventName={currentEvent.name}
              events={events}
              onSwitch={handleEventChange}
            />

            {/* The trail needs a desktop's width; on a phone the event name is enough. */}
            {currentSubPage && (
              <div className="hidden items-center gap-2 text-muted-foreground md:flex">
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
          <h1 className="truncate text-base font-semibold md:text-lg">
            {session?.user?.organizationName || portalTitle(role)}
          </h1>
        )}
      </div>

      {/* ── Right: Notifications + Profile ────────────────────────────────── */}
      <div className="flex shrink-0 items-center gap-2 md:gap-4">
        {receivesEventNotifications(role) && (
          <NotificationBell />
        )}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="flex items-center gap-2" aria-label={`Account menu, ${session?.user?.firstName ?? ""} ${session?.user?.lastName ?? ""}`.trim()}>
              <Avatar className="h-8 w-8">
                <AvatarImage src={session?.user?.image || undefined} />
                <AvatarFallback className="bg-primary text-primary-foreground text-sm font-semibold">
                  {initials}
                </AvatarFallback>
              </Avatar>
              <span className="hidden md:block">
                {session?.user?.firstName} {session?.user?.lastName}
              </span>
              <ChevronDown className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>

          <DropdownMenuContent align="end" className="w-72">
            {/* ── User info ───────────────────────────────────────────────── */}
            <div className="px-3 py-3 space-y-2">
              <div className="flex items-center gap-3">
                <Avatar className="h-10 w-10">
                  <AvatarImage src={session?.user?.image || undefined} />
                  <AvatarFallback className="bg-primary text-primary-foreground font-semibold">
                    {initials}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0">
                  <p className="font-semibold text-sm leading-tight">
                    {session?.user?.firstName} {session?.user?.lastName}
                  </p>
                  <p className="text-xs text-muted-foreground truncate">
                    {session?.user?.email}
                  </p>
                </div>
              </div>

              {/* Role badge */}
              <div className={`inline-flex items-center gap-1.5 text-xs font-medium px-2 py-1 rounded-full ${roleMeta.color}`}>
                <RoleIcon className="h-3 w-3" />
                {roleMeta.label}
              </div>
            </div>

            <DropdownMenuSeparator />

            {/* ── Permissions ─────────────────────────────────────────────── */}
            {/*
              Staff only. A submitter, reviewer or registrant is a guest of the
              event, not an operator of it: listing what they cannot do reads as
              a wall of red crosses about a system they never asked to use. The
              role badge above already tells them which door they came in.
            */}
            {isTeamRole(session?.user?.role) && (
              <>
                <div className="px-3 py-2">
                  <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60 mb-2">
                    Permissions
                  </p>
                  <div className="space-y-1.5">
                    {roleMeta.permissions.map((p) => (
                      <div key={p.label} className="flex items-center gap-2">
                        {p.allowed ? (
                          <Check className="h-3.5 w-3.5 text-green-500 shrink-0" />
                        ) : (
                          <X className="h-3.5 w-3.5 text-muted-foreground/40 shrink-0" />
                        )}
                        <span className={`text-xs ${p.allowed ? "text-foreground" : "text-muted-foreground/60"}`}>
                          {p.label}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                <DropdownMenuSeparator />
              </>
            )}

            {/* ── Actions ─────────────────────────────────────────────────── */}
            {/*
              Staff only, same reasoning as the permissions panel above. /profile
              is the STAFF profile: a name field plus the email signature that
              gets appended to organiser emails. A submitter edits their details
              on My Details and a registrant on their registration; neither ever
              sends an organiser email, so the page has nothing for them.
            */}
            {isTeamRole(session?.user?.role) && (
              <DropdownMenuItem asChild>
                <Link href="/profile" className="flex items-center">
                  <User className="mr-2 h-4 w-4" />
                  Profile
                </Link>
              </DropdownMenuItem>
            )}
            {/* Everyone: the events this person is registered for and the
                certificates sent to them. Staff register for events too, and
                the page says so plainly when there are none. */}
            <DropdownMenuItem asChild>
              <Link href="/my-account" className="flex items-center">
                <Ticket className="mr-2 h-4 w-4" />
                My events
              </Link>
            </DropdownMenuItem>
            {/* Everyone's own details (Nov 9, 2026): the registration form's
                questions on the account, and marketing consent. */}
            <DropdownMenuItem asChild>
              <Link href="/my-account/details" className="flex items-center">
                <UserRound className="mr-2 h-4 w-4" />
                My details
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-amber-600 focus:text-amber-600"
              onClick={() => setConfirmSignOut(true)}
            >
              <LogOut className="mr-2 h-4 w-4" />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <AlertDialog open={confirmSignOut} onOpenChange={setConfirmSignOut}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Sign out?</AlertDialogTitle>
            <AlertDialogDescription>
              You will be signed out on this device and need to sign in again.
              Nothing you have entered is lost, and your role does not change.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Stay signed in</AlertDialogCancel>
            <AlertDialogAction
              className="bg-amber-600 text-white hover:bg-amber-700 focus:ring-amber-600"
              // Attendee-side roles land on their EVENT sign-in, staff on
              // /login — see signOutCallbackUrl (owner report Aug 5, 2026).
              onClick={() =>
                signOut({
                  callbackUrl: signOutCallbackUrl(
                    session?.user?.role,
                    (isEventPage && currentEvent ? currentEvent : events[0]) ?? null,
                  ),
                })
              }
            >
              Sign out
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </header>
  );
}
