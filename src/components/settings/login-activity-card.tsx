"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  ShieldCheck, ShieldAlert, ShieldX, Clock, MapPin, Monitor,
  Smartphone, Globe, ChevronLeft, ChevronRight, RefreshCw, AlertTriangle,
} from "lucide-react";
import { cn } from "@/lib/utils";

type Outcome = "SUCCESS" | "FAILED_PASSWORD" | "FAILED_UNKNOWN_EMAIL" | "BLOCKED_RATE_LIMIT";
type Surface = "DASHBOARD" | "EVENT_PAGE" | "MOBILE";

interface LoginEventRow {
  id: string;
  email: string;
  outcome: Outcome;
  surface: Surface;
  ipAddress: string | null;
  userAgent: string | null;
  geoCity: string | null;
  geoCountry: string | null;
  geoResolvedAt: string | null;
  createdAt: string;
  user: { id: string; firstName: string; lastName: string; role: string } | null;
}

interface LoginActivityResponse {
  events: LoginEventRow[];
  total: number;
  page: number;
  limit: number;
  geoEnabled: boolean;
}

/**
 * Exhaustive over the Prisma enum — adding an outcome without a presentation
 * fails the build rather than rendering a raw enum name at an admin.
 */
const OUTCOME_DISPLAY: Record<Outcome, { label: string; className: string; Icon: typeof ShieldCheck }> = {
  SUCCESS: {
    label: "Signed in",
    className: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:border-emerald-900",
    Icon: ShieldCheck,
  },
  FAILED_PASSWORD: {
    label: "Wrong password",
    className: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-900",
    Icon: ShieldAlert,
  },
  FAILED_UNKNOWN_EMAIL: {
    label: "Unknown address",
    className: "bg-slate-50 text-slate-700 border-slate-200 dark:bg-slate-900 dark:text-slate-300 dark:border-slate-700",
    Icon: ShieldAlert,
  },
  BLOCKED_RATE_LIMIT: {
    label: "Blocked",
    className: "bg-red-50 text-red-700 border-red-200 dark:bg-red-950 dark:text-red-300 dark:border-red-900",
    Icon: ShieldX,
  },
};

const SURFACE_DISPLAY: Record<Surface, { label: string; Icon: typeof Monitor }> = {
  DASHBOARD: { label: "Dashboard", Icon: Monitor },
  EVENT_PAGE: { label: "Event page", Icon: Globe },
  MOBILE: { label: "Mobile app", Icon: Smartphone },
};

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function formatLocation(row: LoginEventRow): string | null {
  const parts = [row.geoCity, row.geoCountry].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

export function LoginActivityCard() {
  const [outcome, setOutcome] = useState<"all" | "success" | "failed">("all");
  const [days, setDays] = useState("30");
  const [page, setPage] = useState(1);
  const limit = 25;

  const { data, isLoading, isFetching, isError, refetch } = useQuery<LoginActivityResponse>({
    queryKey: ["login-activity", outcome, days, page],
    queryFn: async () => {
      const params = new URLSearchParams({
        outcome, days, page: String(page), limit: String(limit),
      });
      const res = await fetch(`/api/organization/login-activity?${params}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Failed to load sign-in activity");
      }
      return res.json();
    },
  });

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1;

  // Any filter change invalidates the current page number.
  function changeFilter(fn: () => void) {
    fn();
    setPage(1);
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-primary/10 text-primary">
                <ShieldCheck className="h-4 w-4" />
              </div>
              Sign-in Activity
            </CardTitle>
            <CardDescription className="mt-1.5">
              Every sign-in attempt against your organization — successful or not.
              Kept for 180 days, then deleted.
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isFetching}
            className="shrink-0"
          >
            <RefreshCw className={cn("h-4 w-4 mr-2", isFetching && "animate-spin")} />
            Refresh
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-3">
          <Select value={outcome} onValueChange={(v) => changeFilter(() => setOutcome(v as typeof outcome))}>
            <SelectTrigger className="w-[190px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All attempts</SelectItem>
              <SelectItem value="success">Successful only</SelectItem>
              <SelectItem value="failed">Failed only</SelectItem>
            </SelectContent>
          </Select>

          <Select value={days} onValueChange={(v) => changeFilter(() => setDays(v))}>
            <SelectTrigger className="w-[170px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1">Last 24 hours</SelectItem>
              <SelectItem value="7">Last 7 days</SelectItem>
              <SelectItem value="30">Last 30 days</SelectItem>
              <SelectItem value="90">Last 90 days</SelectItem>
              <SelectItem value="180">Last 180 days</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {data && !data.geoEnabled && (
          <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>
              Location lookup is switched off (<code className="text-xs">LOGIN_GEO_ENABLED=false</code>),
              so only IP addresses are shown.
            </span>
          </div>
        )}

        {isError ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-6 text-center">
            <p className="text-sm text-destructive font-medium">Couldn&apos;t load sign-in activity.</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={() => refetch()}>
              Try again
            </Button>
          </div>
        ) : isLoading ? (
          <div className="py-10 text-center text-sm text-muted-foreground">Loading…</div>
        ) : !data || data.events.length === 0 ? (
          <div className="py-10 text-center">
            <Clock className="h-8 w-8 mx-auto text-muted-foreground/40" />
            <p className="mt-2 text-sm text-muted-foreground">
              No sign-in attempts recorded in this period.
            </p>
          </div>
        ) : (
          <>
            <div className="rounded-md border overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Person</TableHead>
                    <TableHead>Outcome</TableHead>
                    <TableHead>When</TableHead>
                    <TableHead>Location</TableHead>
                    <TableHead>From</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.events.map((row) => {
                    const display = OUTCOME_DISPLAY[row.outcome];
                    const surface = SURFACE_DISPLAY[row.surface];
                    const location = formatLocation(row);
                    return (
                      <TableRow key={row.id}>
                        <TableCell>
                          <div className="font-medium">
                            {row.user
                              ? `${row.user.firstName} ${row.user.lastName}`
                              : <span className="text-muted-foreground italic">No account</span>}
                          </div>
                          <div className="text-xs text-muted-foreground">{row.email}</div>
                        </TableCell>

                        <TableCell>
                          <Badge variant="outline" className={cn("gap-1 font-normal", display.className)}>
                            <display.Icon className="h-3 w-3" />
                            {display.label}
                          </Badge>
                        </TableCell>

                        <TableCell className="text-sm whitespace-nowrap tabular-nums">
                          {formatWhen(row.createdAt)}
                        </TableCell>

                        <TableCell className="text-sm">
                          {location ? (
                            <span className="flex items-center gap-1.5">
                              <MapPin className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                              {location}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                          <div className="text-xs text-muted-foreground tabular-nums">
                            {row.ipAddress ?? "unknown"}
                          </div>
                        </TableCell>

                        <TableCell className="text-sm">
                          <span className="flex items-center gap-1.5 whitespace-nowrap">
                            <surface.Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                            {surface.label}
                          </span>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>

            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                {data.total} attempt{data.total === 1 ? "" : "s"}
                {totalPages > 1 && ` · page ${data.page} of ${totalPages}`}
              </p>
              {totalPages > 1 && (
                <div className="flex gap-2">
                  <Button
                    variant="outline" size="sm"
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page <= 1 || isFetching}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="outline" size="sm"
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    disabled={page >= totalPages || isFetching}
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              )}
            </div>

            <p className="text-xs text-muted-foreground">
              Locations are approximate — IP geolocation resolves to the network, not the
              person, so a VPN or mobile connection can appear far from where someone
              actually is. Treat it as a &quot;does this look wrong?&quot; signal, not evidence.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
