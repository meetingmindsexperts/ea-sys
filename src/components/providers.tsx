"use client";

import { useState } from "react";
import { SessionProvider } from "next-auth/react";
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Sentry from "@sentry/nextjs";
import { Toaster } from "@/components/ui/sonner";
import { OrgTheme } from "@/components/org-theme";
import { ActiveOrgProvider } from "@/contexts/active-org-context";
import { handleUnauthorized, httpStatusOf, shouldRetryQuery } from "@/lib/session-expiry";

interface ProvidersProps {
  children: React.ReactNode;
}

/**
 * Forward unexpected query/mutation errors to Sentry.
 * Skips 4xx client errors (validation, auth, not found) — those are
 * expected and surfaced to the user via component-level toasts.
 *
 * The skip now reads the error's real HTTP status. It used to test the
 * MESSAGE for a three-digit 4xx, which both over-matched (a genuine fault
 * whose text happened to contain "404" was dropped) and under-matched (a
 * 4xx whose message carried no number was reported). The regex survives
 * only as the fallback for errors with no status at all — thrown strings,
 * network failures.
 */
function reportToSentry(
  error: unknown,
  kind: "query" | "mutation",
  meta?: { queryKey?: readonly unknown[]; variables?: unknown }
) {
  const status = httpStatusOf(error);
  if (status !== undefined && status >= 400 && status < 500) {
    return;
  }

  if (!(error instanceof Error)) {
    Sentry.captureMessage(`React Query ${kind} error (non-Error): ${String(error)}`, {
      level: "error",
      tags: { source: "react-query", kind },
      extra: meta,
    });
    return;
  }

  const message = error.message || "";
  if (status === undefined && (/\b4\d\d\b/.test(message) || /HTTP 4\d\d/i.test(message))) {
    return;
  }

  Sentry.captureException(error, {
    tags: { source: "react-query", kind },
    extra: meta,
  });
}

/**
 * A 401 on a background request means the session expired underneath an open
 * tab. Send the person to sign in instead of rendering an empty page.
 *
 * This is the ONE place every client-side query and mutation failure lands,
 * which is why it belongs here rather than in any single module: the bug was
 * first observed in the CRM, but the same shape existed across the whole
 * dashboard and a CRM-local fix would have left it there. See
 * `src/lib/session-expiry.ts` for what it refuses to redirect, and why.
 *
 * Returns true when the error was handled as an expiry, so we do not also
 * report it as a fault.
 */
function handleExpiredSession(error: unknown, context: Record<string, unknown>): boolean {
  if (httpStatusOf(error) !== 401 || typeof window === "undefined") return false;

  const handled = handleUnauthorized(window.location, (url) => window.location.assign(url));
  if (handled) {
    console.warn("[session] expired — redirecting to sign in", context);
  }
  return handled;
}

export function Providers({ children }: ProvidersProps) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        queryCache: new QueryCache({
          onError: (error, query) => {
            if (handleExpiredSession(error, { queryKey: query.queryKey })) return;
            reportToSentry(error, "query", { queryKey: query.queryKey });
          },
        }),
        mutationCache: new MutationCache({
          onError: (error, variables) => {
            if (handleExpiredSession(error, { variables })) return;
            reportToSentry(error, "mutation", { variables });
          },
        }),
        defaultOptions: {
          queries: {
            // Cache data for 5 minutes
            staleTime: 5 * 60 * 1000,
            // Keep unused data in cache for 30 minutes
            gcTime: 30 * 60 * 1000,
            // Retry once, except auth failures. Extracted so the policy is
            // pinned by a test — see shouldRetryQuery.
            retry: shouldRetryQuery,
            // Refetch on window focus for fresh data
            refetchOnWindowFocus: true,
          },
        },
      })
  );

  return (
    <QueryClientProvider client={queryClient}>
      <SessionProvider>
        <ActiveOrgProvider>
          <OrgTheme />
          {children}
          <Toaster />
        </ActiveOrgProvider>
      </SessionProvider>
    </QueryClientProvider>
  );
}
