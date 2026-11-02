"use client";

/**
 * The exhibitor floor plan (docs/VENUE_FLOOR_PLAN_EDITOR_PLAN.md section 10): the page behind the event's secret
 * link, for every sponsor and exhibitor to find their stand. It shows only what the server returned; the server has
 * already removed staff-only items, notes and any drawing not ticked for exhibitors.
 *
 * Stand numbers can change up to the last minute, so it refetches every 60 seconds while the tab is visible, and
 * at once when the viewer comes back to it.
 */
import { useQuery } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { Link2Off, Loader2 } from "lucide-react";
import { ExhibitorFloorPlan, type FloorPlanPayload } from "@/components/public/exhibitor-floor-plan";

const REFRESH_MS = 60_000;

const MESSAGES = {
  "not-ready": { title: "The floor plan is not ready yet", body: "The organiser is still preparing it. Please check this link again later." },
  inactive: { title: "This link is no longer active", body: "Ask the organiser for the current floor plan link." },
  failed: { title: "The floor plan could not be loaded", body: "Check your connection and reload the page." },
};

export default function ExhibitorFloorPlanPage() {
  const { slug, token } = useParams<{ slug: string; token: string }>();
  const result = useQuery({
    queryKey: ["public-floor-plan", slug, token],
    queryFn: async (): Promise<FloorPlanPayload | "inactive" | "not-ready"> => {
      const res = await fetch(`/api/public/events/${encodeURIComponent(slug)}/floor-plan/${encodeURIComponent(token)}`, { cache: "no-store" });
      if (res.status === 404) return "inactive";
      if (res.status === 409) return "not-ready";
      if (!res.ok) {
        console.warn("public-floor-plan:load-failed", res.status);
        throw new Error(`Load failed (${res.status})`);
      }
      return (await res.json()) as FloorPlanPayload;
    },
    refetchInterval: REFRESH_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: 1,
  });

  if (result.isLoading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-50">
        <Loader2 className="h-6 w-6 animate-spin text-slate-400" aria-label="Loading the floor plan" />
      </main>
    );
  }
  if (result.data === "inactive" || result.data === "not-ready" || result.isError || !result.data) {
    const message = MESSAGES[result.data === "not-ready" || result.data === "inactive" ? result.data : "failed"];
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
        <div className="max-w-sm space-y-2 text-center">
          <Link2Off className="mx-auto h-8 w-8 text-slate-400" aria-hidden />
          <h1 className="text-lg font-semibold text-slate-900">{message.title}</h1>
          <p className="text-sm text-slate-600">{message.body}</p>
        </div>
      </main>
    );
  }
  return <ExhibitorFloorPlan data={result.data} pdfBase={`/api/public/events/${encodeURIComponent(slug)}/floor-plan/${encodeURIComponent(token)}/pdf`} />;
}
