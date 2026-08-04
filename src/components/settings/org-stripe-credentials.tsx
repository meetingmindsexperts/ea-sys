"use client";

import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Loader2, Save, CheckCircle2, XCircle, CreditCard, Trash2, Copy } from "lucide-react";
import { toast } from "sonner";
import {
  useStripeCredentials,
  useSaveStripeCredentials,
  useDeleteStripeCredentials,
  useTestStripeConnection,
} from "@/hooks/use-api";

/**
 * Org Stripe credentials card (Settings → Integrations; per-tenant keys,
 * item 7). Modeled on OrgZoomCredentials: secrets live in empty local state
 * with a "(saved)" placeholder — the ciphertext never reaches the browser;
 * blank fields are omitted from the payload so saved values are kept.
 */
export function OrgStripeCredentials() {
  const { data: config, isLoading } = useStripeCredentials();
  const saveCredentials = useSaveStripeCredentials();
  const deleteCredentials = useDeleteStripeCredentials();
  const testConnection = useTestStripeConnection();

  const [secretKey, setSecretKey] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [connectionStatus, setConnectionStatus] = useState<"idle" | "success" | "error">("idle");
  const [connectedAccount, setConnectedAccount] = useState<string | null>(null);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!config?.hasSecretKey && !secretKey.trim()) {
      toast.error("The Stripe secret key is required on first setup");
      return;
    }
    if (!secretKey.trim() && !webhookSecret.trim()) {
      toast.error("Nothing to save — enter a new key or webhook secret");
      return;
    }
    try {
      await saveCredentials.mutateAsync({
        ...(secretKey.trim() && { secretKey: secretKey.trim() }),
        ...(webhookSecret.trim() && { webhookSecret: webhookSecret.trim() }),
      });
      toast.success("Stripe credentials saved");
      setSecretKey("");
      setWebhookSecret("");
      setConnectionStatus("idle");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save credentials");
    }
  };

  const handleTestConnection = async () => {
    setConnectionStatus("idle");
    setConnectedAccount(null);
    try {
      const result = await testConnection.mutateAsync();
      if (result.success) {
        setConnectionStatus("success");
        const label = result.account?.name || result.account?.email || result.account?.id || "Stripe account";
        setConnectedAccount(`${label} (${result.source === "org" ? "this organization's key" : "platform default key"})`);
        toast.success("Connection successful");
      } else {
        setConnectionStatus("error");
        toast.error(result.error || "Connection failed");
      }
    } catch (err) {
      setConnectionStatus("error");
      toast.error(err instanceof Error ? err.message : "Connection test failed");
    }
  };

  const handleDelete = async () => {
    if (!window.confirm("Remove this organization's Stripe keys? Payments fall back to the platform default account.")) return;
    try {
      await deleteCredentials.mutateAsync();
      toast.success("Stripe credentials removed");
      setSecretKey("");
      setWebhookSecret("");
      setConnectionStatus("idle");
      setConnectedAccount(null);
    } catch {
      toast.error("Failed to remove credentials");
    }
  };

  const handleCopyWebhookUrl = async () => {
    if (!config?.webhookUrl) return;
    try {
      await navigator.clipboard.writeText(config.webhookUrl);
      toast.success("Webhook URL copied");
    } catch {
      toast.error("Couldn't copy — select and copy the URL manually");
    }
  };

  if (isLoading) return null;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-violet-50 text-violet-600">
                <CreditCard className="h-4 w-4" />
              </div>
              Stripe Payments
            </CardTitle>
            <CardDescription className="mt-1">
              Use your organization&apos;s own Stripe account for registration payments. Leave unset to use the platform default.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {config?.keyMode && (
              <Badge
                variant="outline"
                className={
                  config.keyMode === "live"
                    ? "bg-green-50 text-green-700 border-green-200"
                    : "bg-amber-50 text-amber-700 border-amber-200"
                }
              >
                {config.keyMode === "live" ? "Live" : "Test"} mode
              </Badge>
            )}
            {config?.configured && (
              <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200">
                Configured
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSave} className="space-y-5">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="stripe-secret-key">Secret Key</Label>
              <Input
                id="stripe-secret-key"
                type="password"
                value={secretKey}
                onChange={(e) => setSecretKey(e.target.value)}
                placeholder={
                  config?.hasSecretKey
                    ? `••••••••${config.secretKeyLast4 ?? ""}  (saved)`
                    : "sk_live_…"
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="stripe-webhook-secret">Webhook Signing Secret</Label>
              <Input
                id="stripe-webhook-secret"
                type="password"
                value={webhookSecret}
                onChange={(e) => setWebhookSecret(e.target.value)}
                placeholder={config?.hasWebhookSecret ? "••••••••  (saved)" : "whsec_…"}
              />
            </div>
          </div>

          {/* ── Webhook setup instructions ─────────────────── */}
          <div className="rounded-lg border bg-muted/40 p-3 space-y-2">
            <p className="text-sm font-medium">Webhook endpoint for this organization</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded bg-background border px-2 py-1 text-xs">
                {config?.webhookUrl}
              </code>
              <Button type="button" variant="outline" size="sm" onClick={handleCopyWebhookUrl}>
                <Copy className="h-3.5 w-3.5" />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              In your Stripe Dashboard → Developers → Webhooks, add this endpoint and enable the events{" "}
              <code>checkout.session.completed</code>, <code>checkout.session.expired</code>,{" "}
              <code>charge.refunded</code> and <code>payment_intent.payment_failed</code> — then paste the
              endpoint&apos;s signing secret into the field above and send a test event from Stripe to verify.
            </p>
          </div>

          <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2">
            Changing Stripe accounts after payments exist means earlier payments can only be refunded from the
            account that originally collected them. Set the key before selling, or keep the same account&apos;s key.
          </p>

          {/* ── Actions ───────────────────────────────────── */}
          <div className="flex items-center gap-3 border-t pt-4">
            <Button type="submit" disabled={saveCredentials.isPending}>
              {saveCredentials.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              <Save className="mr-2 h-4 w-4" />
              Save Credentials
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={handleTestConnection}
              disabled={testConnection.isPending}
            >
              {testConnection.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Test Connection
            </Button>
            {config?.configured && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-red-600 hover:text-red-700 hover:bg-red-50"
                onClick={handleDelete}
                disabled={deleteCredentials.isPending}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
            {connectionStatus === "success" && (
              <span className="flex items-center gap-1 text-sm text-green-600">
                <CheckCircle2 className="h-4 w-4" />
                {connectedAccount ? `Connected: ${connectedAccount}` : "Connected"}
              </span>
            )}
            {connectionStatus === "error" && (
              <span className="flex items-center gap-1 text-sm text-red-600">
                <XCircle className="h-4 w-4" /> Failed
              </span>
            )}
          </div>
        </form>

        {config?.configuredAt && (
          <p className="mt-3 text-xs text-muted-foreground">
            Last configured: {new Date(config.configuredAt).toLocaleDateString()}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
