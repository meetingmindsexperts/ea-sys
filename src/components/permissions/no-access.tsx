"use client";

import Link from "next/link";
import { useSession } from "next-auth/react";
import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { roleLabelOf } from "@/components/layout/header";

/**
 * The one "you can't open this" panel (owner, Oct 5, 2026). A refused page
 * says so and names who to ask, instead of rendering the refusal as an empty
 * list, a spinner that never stops, or a blank page.
 */
export function NoAccess({ what, back }: { what?: string; back?: { href: string; label: string } }) {
  const { data: session } = useSession();
  const role = roleLabelOf(session?.user?.role);
  const target = back ?? { href: "/events", label: "Back to Events" };

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="w-full max-w-md rounded-xl border bg-card p-8 text-center shadow-sm" role="alert">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <Lock className="h-5 w-5 text-muted-foreground" aria-hidden />
        </div>
        <h1 className="text-lg font-semibold">You don&apos;t have access to {what ?? "this page"}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {role ? <>Your role, <span className="font-medium text-foreground">{role}</span>, doesn&apos;t include it. </> : null}
          If you need it for your work, ask an organisation admin to change your access.
        </p>
        <Button asChild variant="outline" className="mt-6">
          <Link href={target.href}>{target.label}</Link>
        </Button>
      </div>
    </div>
  );
}

/**
 * An event the person is not on, for the identities from outside the
 * organisation (Oct 30, 2026). "Ask an organisation admin to change your
 * access" is right for staff and wrong here: a submitter or registrant joins an
 * event by registering for it, and a reviewer by being added by its team.
 */
export function NotOnThisEvent({ role }: { role: string }) {
  const reviewer = role === "REVIEWER";
  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="w-full max-w-md rounded-xl border bg-card p-8 text-center shadow-sm" role="alert">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <Lock className="h-5 w-5 text-muted-foreground" aria-hidden />
        </div>
        <h1 className="text-lg font-semibold">
          {reviewer ? "You are not a reviewer for this event" : "You are not registered for this event"}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {reviewer
            ? "Ask the event's organising team to add you as a reviewer. It will then appear in your events."
            : "Register for it first from the event's registration or abstract submission page. Sign in there with this same account and the event will appear here."}
        </p>
        <Button asChild variant="outline" className="mt-6">
          <Link href="/events">Back to my events</Link>
        </Button>
      </div>
    </div>
  );
}
