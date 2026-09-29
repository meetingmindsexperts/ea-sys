"use client";

/**
 * Shared view (Sep 29, 2026; docs/SUBMISSION_SHARE_PLAN.md and
 * docs/REGISTRATION_SHARE_PLAN.md): the read-only page behind an organiser's
 * secret link, for abstracts, session proposals or a registration view. It shows only what the
 * server returned; the server has already removed every field the organiser
 * did not switch on, so nothing here decides what is private.
 *
 * "Live": it refetches every 60 seconds while the tab is visible, and at once
 * when the viewer comes back to the tab.
 */
import { useQuery } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { Link2Off, Loader2 } from "lucide-react";
import { RegistrationsView } from "@/components/public/shared-view/registrations-view";
import { SubmissionsView } from "@/components/public/shared-view/submissions-view";
import type { SharedPayload } from "@/components/public/shared-view/types";

const REFRESH_MS = 60_000;

export default function SharedSubmissionsPage() {
  const { slug, token } = useParams<{ slug: string; token: string }>();
  // React Query owns the polling: every 60 s while the tab is visible (no
  // background polling), and at once when the viewer returns to the tab. A 404
  // is an ANSWER (the link was switched off or replaced), not an error, so it
  // resolves rather than throws and never trips the global error handler.
  const result = useQuery({
    queryKey: ["public-shared", slug, token],
    queryFn: async (): Promise<SharedPayload | "inactive"> => {
      const res = await fetch(`/api/public/events/${encodeURIComponent(slug)}/shared/${encodeURIComponent(token)}`, {
        cache: "no-store",
      });
      if (res.status === 404) return "inactive";
      if (!res.ok) {
        console.warn("shared-submissions:load-failed", res.status);
        throw new Error(`Load failed (${res.status})`);
      }
      return (await res.json()) as SharedPayload;
    },
    refetchInterval: REFRESH_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    staleTime: 0,
    retry: 1,
  });
  const inactive = result.data === "inactive";
  const data = result.data && result.data !== "inactive" ? result.data : null;
  const loadError = result.isError;

  if (inactive) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-sm ring-1 ring-slate-200 p-10 w-full max-w-md text-center">
          <div className="mx-auto mb-5 h-14 w-14 rounded-full bg-slate-100 flex items-center justify-center">
            <Link2Off className="h-7 w-7 text-slate-400" />
          </div>
          <h1 className="text-lg font-bold text-slate-900 mb-2">This link is no longer active</h1>
          <p className="text-sm text-slate-500">Ask the organiser for a new one.</p>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        {loadError ? (
          <p className="text-sm text-slate-500">This page could not be loaded. It will try again shortly.</p>
        ) : (
          <Loader2 className="h-8 w-8 animate-spin text-primary" aria-label="Loading" />
        )}
      </div>
    );
  }

  return data.kind === "REGISTRATIONS" ? <RegistrationsView data={data} /> : <SubmissionsView data={data} />;
}
