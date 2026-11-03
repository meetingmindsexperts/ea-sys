"use client";

import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, Loader2, Save, Ticket, Trash2, XCircle } from "lucide-react";
import { toast } from "sonner";
import {
  useDeleteDtcmEticketCredentials,
  useDtcmEticketCredentials,
  useSaveDtcmEticketCredentials,
  useTestDtcmEticketConnection,
} from "@/hooks/use-api";
import { normalizeDtcmPerformanceCode } from "@/lib/dtcm-performance-code";
import type { DetCredentialsStatus, DetEnvironment, DetPerformanceSummary } from "@/lib/dtcm-eticket/types";

const ENV_LABEL: Record<DetEnvironment, string> = { staging: "Sandbox (UAT)", production: "Production" };

/**
 * Org DET eTicketing credentials (Settings → Integrations;
 * docs/DTCM_ETICKET_PLAN.md step 1). Modelled on OrgStripeCredentials: secrets
 * live in empty local state with a "(saved)" placeholder, so ciphertext never
 * reaches the browser and a blank field keeps the stored value. One
 * environment is edited at a time; saving it makes it the active one.
 */
export function OrgDtcmEticketCredentials() {
  const { data: config, isLoading } = useDtcmEticketCredentials();
  if (isLoading || !config) return null;
  return <CredentialsForm config={config} />;
}

/** Mounted once the settings are loaded, so its state starts from them. */
function CredentialsForm({ config }: { config: DetCredentialsStatus }) {
  const save = useSaveDtcmEticketCredentials();
  const remove = useDeleteDtcmEticketCredentials();
  const test = useTestDtcmEticketConnection();

  const [environment, setEnvironment] = useState<DetEnvironment>(config.activeEnvironment);
  const [clientId, setClientId] = useState(config[config.activeEnvironment].clientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [performanceCode, setPerformanceCode] = useState("");
  const [result, setResult] = useState<{ ok: boolean; message: string; performance: DetPerformanceSummary | null } | null>(null);

  const saved = config[environment];

  // Each environment shows its own saved client id; typed secrets never carry across.
  const switchEnvironment = (env: DetEnvironment) => {
    setEnvironment(env);
    setClientId(config[env].clientId ?? "");
    setClientSecret("");
    setApiKey("");
    setResult(null);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!clientId.trim()) {
      toast.error("Enter the client id DET issued");
      return;
    }
    try {
      await save.mutateAsync({
        environment,
        clientId: clientId.trim(),
        ...(clientSecret.trim() && { clientSecret: clientSecret.trim() }),
        ...(apiKey.trim() && { apiKey: apiKey.trim() }),
      });
      toast.success(`${ENV_LABEL[environment]} credentials saved and active`);
      setClientSecret("");
      setApiKey("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save credentials");
    }
  };

  const handleTest = async () => {
    setResult(null);
    try {
      const code = normalizeDtcmPerformanceCode(performanceCode);
      const out = await test.mutateAsync({ environment, ...(code && { performanceCode: code }) });
      setResult({ ok: true, message: `Connected to DET ${ENV_LABEL[environment]} as ${out.clientId}`, performance: out.performance ?? null });
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : "Connection test failed", performance: null });
    }
  };

  const handleDelete = async () => {
    if (!window.confirm("Remove the DET credentials for both environments? Nothing can be bought from DET until they are entered again.")) return;
    try {
      await remove.mutateAsync();
      toast.success("DET credentials removed");
      setResult(null);
    } catch {
      toast.error("Failed to remove credentials");
    }
  };

  const anyConfigured = config.staging.configured || config.production.configured;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-amber-50 text-amber-600">
                <Ticket className="h-4 w-4" />
              </div>
              DTCM eTicketing (Dubai)
            </CardTitle>
            <CardDescription className="mt-1">
              The organisation&apos;s DET eTicketing account, used to issue DTCM barcodes for Dubai events. The sandbox is
              for rehearsal; production issues real tickets against the event permit.
            </CardDescription>
          </div>
          {anyConfigured && (
            <Badge
              variant="outline"
              className={
                config.activeEnvironment === "production"
                  ? "bg-green-50 text-green-700 border-green-200"
                  : "bg-amber-50 text-amber-700 border-amber-200"
              }
            >
              Active: {ENV_LABEL[config.activeEnvironment]}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSave} className="space-y-5">
          <div className="inline-flex rounded-lg border p-1" role="tablist" aria-label="DET environment">
            {(["staging", "production"] as const).map((env) => (
              <button
                key={env}
                type="button"
                role="tab"
                aria-selected={environment === env}
                onClick={() => switchEnvironment(env)}
                className={
                  environment === env
                    ? "rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
                    : "rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
                }
              >
                {ENV_LABEL[env]}
                {config[env].configured && <CheckCircle2 className="ml-1.5 inline h-3.5 w-3.5" aria-label="saved" />}
              </button>
            ))}
          </div>

          {environment === "production" && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2">
              Production issues real DTCM tickets against the event&apos;s permit, and DET only answers it from the IP
              address it whitelisted for you (the live server). A test from anywhere else fails at the token step.
            </p>
          )}

          <div className="grid gap-4 md:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="det-client-id">Client ID (seller code)</Label>
              <Input
                id="det-client-id"
                value={clientId}
                onChange={(e) => setClientId(e.target.value.toUpperCase())}
                placeholder="e.g., AMMEE1"
                autoComplete="off"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="det-client-secret">Client secret</Label>
              <Input
                id="det-client-secret"
                type="password"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                placeholder={saved.hasClientSecret ? "••••••••  (saved)" : "From DET"}
                autoComplete="off"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="det-api-key">API key</Label>
              <Input
                id="det-api-key"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={saved.apiKeyLast4 ? `••••••••${saved.apiKeyLast4}  (saved)` : "From DET"}
                autoComplete="off"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-3 border-t pt-4">
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
              Save and use {ENV_LABEL[environment]}
            </Button>
            <div className="space-y-1">
              <Label htmlFor="det-test-performance" className="text-xs text-muted-foreground">
                Performance code to check (optional)
              </Label>
              <Input
                id="det-test-performance"
                value={performanceCode}
                onChange={(e) => setPerformanceCode(e.target.value.toUpperCase())}
                placeholder="e.g., PDUB01DEC2026A"
                className="w-56 font-mono"
              />
            </div>
            <Button type="button" variant="outline" onClick={handleTest} disabled={test.isPending || !saved.configured}>
              {test.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Test connection
            </Button>
            {anyConfigured && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-red-600 hover:text-red-700 hover:bg-red-50"
                onClick={handleDelete}
                disabled={remove.isPending}
                aria-label="Remove DET credentials"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
          </div>
        </form>

        {result && <TestResult ok={result.ok} message={result.message} performance={result.performance} />}

        {saved.configuredAt && (
          <p className="mt-3 text-xs text-muted-foreground">
            {ENV_LABEL[environment]} last saved: {new Date(saved.configuredAt).toLocaleString()}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function TestResult({ ok, message, performance }: { ok: boolean; message: string; performance: DetPerformanceSummary | null }) {
  return (
    <div className="mt-4 space-y-3">
      <p className={ok ? "flex items-center gap-1.5 text-sm text-green-700" : "flex items-start gap-1.5 text-sm text-red-600"}>
        {ok ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0" />}
        {message}
      </p>
      {performance && (
        <div className="rounded-lg border p-3 text-sm">
          <p className="font-medium">
            {performance.name} <span className="font-mono text-muted-foreground">({performance.performanceCode})</span>
          </p>
          <p className="text-xs text-muted-foreground">
            {[performance.venueCode, performance.startDate?.slice(0, 10), performance.endDate?.slice(0, 10)].filter(Boolean).join(" · ")}
          </p>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="py-1 pr-3 font-medium">Section</th>
                  <th className="py-1 pr-3 font-medium">Name</th>
                  <th className="py-1 pr-3 text-right font-medium">Capacity</th>
                  <th className="py-1 text-right font-medium">Holds</th>
                </tr>
              </thead>
              <tbody>
                {performance.sections.map((s) => (
                  <tr key={s.code} className="border-t">
                    <td className="py-1 pr-3 font-mono">{s.code}</td>
                    <td className="py-1 pr-3">{s.name}</td>
                    <td className="py-1 pr-3 text-right tabular-nums">{s.capacity ?? "-"}</td>
                    <td className="py-1 text-right tabular-nums">{s.holds ?? "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
