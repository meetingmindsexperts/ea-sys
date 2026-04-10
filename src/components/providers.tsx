"use client";

import { useState } from "react";
import { SessionProvider } from "next-auth/react";
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Sentry from "@sentry/nextjs";
import { Toaster } from "@/components/ui/sonner";
import { OrgTheme } from "@/components/org-theme";
import { ActiveOrgProvider } from "@/contexts/active-org-context";

interface ProvidersProps {
  children: React.ReactNode;
}

/**
 * Forward unexpected query/mutation errors to Sentry.
 * Skips 4xx client errors (validation, auth, not found) — those are
 * expected and surfaced to the user via component-level toasts.
 */
function reportToSentry(
  error: unknown,
  kind: "query" | "mutation",
  meta?: { queryKey?: readonly unknown[]; variables?: unknown }
) {
  if (!(error instanceof Error)) {
    Sentry.captureMessage(`React Query ${kind} error (non-Error): ${String(error)}`, {
      level: "error",
      tags: { source: "react-query", kind },
      extra: meta,
    });
    return;
  }

  // Heuristic: skip 4xx — those are expected user errors and already toasted
  const message = error.message || "";
  if (/\b4\d\d\b/.test(message) || /HTTP 4\d\d/i.test(message)) {
    return;
  }

  Sentry.captureException(error, {
    tags: { source: "react-query", kind },
    extra: meta,
  });
}

export function Providers({ children }: ProvidersProps) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        queryCache: new QueryCache({
          onError: (error, query) =>
            reportToSentry(error, "query", { queryKey: query.queryKey }),
        }),
        mutationCache: new MutationCache({
          onError: (error, variables) =>
            reportToSentry(error, "mutation", { variables }),
        }),
        defaultOptions: {
          queries: {
            // Cache data for 5 minutes
            staleTime: 5 * 60 * 1000,
            // Keep unused data in cache for 30 minutes
            gcTime: 30 * 60 * 1000,
            // Retry failed requests once
            retry: 1,
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
