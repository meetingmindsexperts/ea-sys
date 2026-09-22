"use client";

/**
 * QuickBooks card on Settings → Integrations (September 22, 2026).
 *
 * The first slice of the accounting connector: connect a QuickBooks
 * company, prove the connection works, and read back the two lists the
 * budget module maps onto (Classes, which are event codes, and the chart of
 * accounts). Nothing is written to QuickBooks from here.
 */

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, CheckCircle2, XCircle, BookOpen, Plug, Unplug, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import {
  useQuickBooksConnection,
  useQuickBooksChart,
  useTestQuickBooksConnection,
  useDisconnectQuickBooks,
} from "@/hooks/use-api";

/** The reasons the callback can redirect with, in words an operator can act on. */
const CALLBACK_REASONS: Record<string, string> = {
  declined: "The QuickBooks consent screen was declined.",
  forbidden: "Your role cannot connect QuickBooks. Ask someone with the settle grant.",
  intuit_error: "Intuit returned an error before the connection was made.",
  missing_params: "Intuit's response was incomplete. Start the connection again.",
  state_expired: "The connection took too long to finish. Start it again.",
  state_invalid: "That connection attempt could not be verified. Start it again.",
  not_configured: "No QuickBooks app is configured for this deployment.",
  exchange_failed: "Intuit refused to issue tokens. Check the app's credentials and redirect URI.",
};

function formatWhen(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "never" : d.toLocaleString();
}

export function OrgQuickBooksConnection() {
  const params = useSearchParams();
  const { data, isLoading, refetch } = useQuickBooksConnection();
  const testConnection = useTestQuickBooksConnection();
  const disconnect = useDisconnectQuickBooks();
  const [showChart, setShowChart] = useState(false);
  const chart = useQuickBooksChart(showChart);
  // A ref, not state: the callback outcome is shown once and changes nothing
  // that renders, and setState inside an effect is a cascading render.
  const handledCallback = useRef(false);

  // The callback redirects back here with the outcome; show it once.
  const outcome = params.get("quickbooks");
  useEffect(() => {
    if (!outcome || handledCallback.current) return;
    handledCallback.current = true;
    if (outcome === "connected") {
      const company = params.get("company");
      toast.success(company ? `Connected to ${company}` : "Connected to QuickBooks");
      void refetch();
    } else {
      toast.error(CALLBACK_REASONS[params.get("reason") ?? ""] ?? "The QuickBooks connection failed.");
    }
  }, [outcome, params, refetch]);

  const connection = data?.connection;
  const connected = !!connection?.connected;

  const handleTest = async () => {
    try {
      const res = await testConnection.mutateAsync();
      toast.success(res.company?.companyName ? `Connected to ${res.company.companyName}` : "QuickBooks answered");
      void refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "QuickBooks did not answer");
      void refetch();
    }
  };

  const handleDisconnect = async () => {
    if (!confirm("Disconnect this QuickBooks company? Budgets and orders stay in EA-SYS; nothing is deleted in QuickBooks.")) return;
    try {
      await disconnect.mutateAsync();
      toast.success("Disconnected from QuickBooks");
      setShowChart(false);
      void refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not disconnect");
    }
  };

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 py-8 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading QuickBooks…
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2">
              <BookOpen className="h-5 w-5 text-primary" />
              QuickBooks
            </CardTitle>
            <CardDescription>
              Link the QuickBooks company that budgets and purchase orders report into. Read-only for now: this
              slice proves the connection and reads the Classes and chart of accounts.
            </CardDescription>
          </div>
          {data?.environment && (
            <Badge variant={data.environment === "production" ? "default" : "secondary"}>{data.environment}</Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {!data?.configured && (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
            No QuickBooks app is configured for this deployment. Set the client id, client secret and redirect URI
            in the environment, then reload this page.
          </div>
        )}

        {data?.configured && connection?.environmentMismatch && (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
            The stored connection is a {connection.environment} company, but this deployment is pointed at{" "}
            {data.environment}. Disconnect and connect again.
          </div>
        )}

        {data?.configured && !connected && !connection?.environmentMismatch && (
          <p className="text-sm text-muted-foreground">Not connected to a QuickBooks company yet.</p>
        )}

        {connected && (
          <div className="grid gap-2 text-sm sm:grid-cols-2">
            <div>
              <span className="text-muted-foreground">Company</span>
              <div className="font-medium">{connection?.companyName ?? "(name not read yet)"}</div>
            </div>
            <div>
              <span className="text-muted-foreground">Realm</span>
              <div className="font-mono text-xs">{connection?.realmId}</div>
            </div>
            <div>
              <span className="text-muted-foreground">Connected</span>
              <div>{formatWhen(connection?.connectedAt ?? null)}</div>
            </div>
            <div>
              <span className="text-muted-foreground">Last checked</span>
              <div className="flex items-center gap-1.5">
                {connection?.lastHealthCheckOk === true && <CheckCircle2 className="h-4 w-4 text-emerald-600" />}
                {connection?.lastHealthCheckOk === false && <XCircle className="h-4 w-4 text-destructive" />}
                {formatWhen(connection?.lastHealthCheckAt ?? null)}
              </div>
            </div>
            {connection?.lastHealthCheckOk === false && connection.lastHealthCheckError && (
              <div className="sm:col-span-2 text-destructive">{connection.lastHealthCheckError}</div>
            )}
          </div>
        )}

        <div className="flex flex-wrap gap-2 pt-2">
          {data?.configured && !connected && (
            // A full navigation, not a fetch: the route answers with a 302 to Intuit's consent screen.
            <Button asChild>
              <a href="/api/integrations/quickbooks/connect">
                <Plug className="mr-2 h-4 w-4" />
                Connect QuickBooks
              </a>
            </Button>
          )}
          {connected && (
            <>
              <Button variant="outline" onClick={handleTest} disabled={testConnection.isPending}>
                {testConnection.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                Test connection
              </Button>
              <Button variant="outline" onClick={() => setShowChart((v) => !v)}>
                <BookOpen className="mr-2 h-4 w-4" />
                {showChart ? "Hide" : "Show"} Classes and accounts
              </Button>
              <Button variant="outline" onClick={handleDisconnect} disabled={disconnect.isPending}>
                {disconnect.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Unplug className="mr-2 h-4 w-4" />}
                Disconnect
              </Button>
            </>
          )}
          {data?.configured && !connected && connection?.environmentMismatch && (
            <Button variant="outline" onClick={handleDisconnect} disabled={disconnect.isPending}>
              <Unplug className="mr-2 h-4 w-4" />
              Disconnect
            </Button>
          )}
        </div>

        {showChart && (
          <div className="rounded-md border p-3">
            {chart.isLoading && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Reading QuickBooks…
              </div>
            )}
            {chart.isError && <div className="text-sm text-destructive">{(chart.error as Error)?.message ?? "Could not read QuickBooks"}</div>}
            {chart.data && (
              <div className="space-y-3 text-sm">
                <div>
                  <div className="font-medium">Classes ({chart.data.counts.classes})</div>
                  <p className="text-xs text-muted-foreground">An event code is a QuickBooks Class.</p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {chart.data.classes.length === 0 && <span className="text-muted-foreground">None yet.</span>}
                    {chart.data.classes.slice(0, 40).map((c) => (
                      <Badge key={c.id} variant={c.active ? "secondary" : "outline"}>
                        {c.fullyQualifiedName ?? c.name}
                      </Badge>
                    ))}
                    {chart.data.classes.length > 40 && (
                      <span className="text-xs text-muted-foreground">and {chart.data.classes.length - 40} more</span>
                    )}
                  </div>
                </div>
                <div>
                  <div className="font-medium">Chart of accounts ({chart.data.counts.accounts})</div>
                  <div className="mt-1 max-h-64 overflow-y-auto">
                    <table className="w-full text-xs">
                      <thead className="text-muted-foreground">
                        <tr>
                          <th className="py-1 text-left font-medium">Number</th>
                          <th className="py-1 text-left font-medium">Account</th>
                          <th className="py-1 text-left font-medium">Type</th>
                        </tr>
                      </thead>
                      <tbody>
                        {chart.data.accounts.slice(0, 200).map((a) => (
                          <tr key={a.id} className="border-t">
                            <td className="py-1 font-mono">{a.acctNum ?? "—"}</td>
                            <td className="py-1">{a.fullyQualifiedName ?? a.name}</td>
                            <td className="py-1 text-muted-foreground">{a.accountType ?? "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
