"use client";

import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Save, CheckCircle2, XCircle, Video, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  useZoomCredentials,
  useSaveZoomCredentials,
  useDeleteZoomCredentials,
  useTestZoomConnection,
} from "@/hooks/use-api";

export function OrgZoomCredentials() {
  const { data: config, isLoading } = useZoomCredentials();
  const saveCredentials = useSaveZoomCredentials();
  const deleteCredentials = useDeleteZoomCredentials();
  const testConnection = useTestZoomConnection();

  const [accountId, setAccountId] = useState<string | null>(null);
  const [clientId, setClientId] = useState<string | null>(null);
  const [clientSecret, setClientSecret] = useState("");
  // SDK Dev
  const [sdkKeyDev, setSdkKeyDev] = useState<string | null>(null);
  const [sdkSecretDev, setSdkSecretDev] = useState("");
  // SDK Prod
  const [sdkKeyProd, setSdkKeyProd] = useState<string | null>(null);
  const [sdkSecretProd, setSdkSecretProd] = useState("");
  // Mode
  const [sdkMode, setSdkMode] = useState<string | null>(null);

  const [connectionStatus, setConnectionStatus] = useState<"idle" | "success" | "error">("idle");
  const [connectedAccount, setConnectedAccount] = useState<string | null>(null);

  const displayAccountId = accountId ?? config?.accountId ?? "";
  const displayClientId = clientId ?? config?.clientId ?? "";
  const displaySdkKeyDev = sdkKeyDev ?? config?.sdkKeyDev ?? "";
  const displaySdkKeyProd = sdkKeyProd ?? config?.sdkKeyProd ?? "";
  const displaySdkMode = sdkMode ?? config?.sdkMode ?? "dev";

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!displayAccountId.trim() || !displayClientId.trim()) {
      toast.error("Account ID and Client ID are required");
      return;
    }
    // Require client secret on first setup only
    if (!config?.hasClientSecret && !clientSecret.trim()) {
      toast.error("Client Secret is required");
      return;
    }
    try {
      await saveCredentials.mutateAsync({
        accountId: displayAccountId.trim(),
        clientId: displayClientId.trim(),
        ...(clientSecret.trim() && { clientSecret: clientSecret.trim() }),
        ...(displaySdkKeyDev.trim() && { sdkKeyDev: displaySdkKeyDev.trim() }),
        ...(sdkSecretDev.trim() && { sdkSecretDev: sdkSecretDev.trim() }),
        ...(displaySdkKeyProd.trim() && { sdkKeyProd: displaySdkKeyProd.trim() }),
        ...(sdkSecretProd.trim() && { sdkSecretProd: sdkSecretProd.trim() }),
        sdkMode: displaySdkMode as "dev" | "prod",
      });
      toast.success("Zoom credentials saved");
      setClientSecret("");
      setSdkSecretDev("");
      setSdkSecretProd("");
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
      if (result.success && result.account) {
        setConnectionStatus("success");
        setConnectedAccount(`${result.account.firstName} ${result.account.lastName} (${result.account.email})`);
        toast.success("Connection successful");
      } else {
        setConnectionStatus("error");
        toast.error(result.error || "Connection failed");
      }
    } catch {
      setConnectionStatus("error");
      toast.error("Connection test failed");
    }
  };

  const handleDelete = async () => {
    try {
      await deleteCredentials.mutateAsync();
      toast.success("Zoom credentials removed");
      setAccountId(null);
      setClientId(null);
      setClientSecret("");
      setSdkKeyDev(null);
      setSdkSecretDev("");
      setSdkKeyProd(null);
      setSdkSecretProd("");
      setSdkMode(null);
      setConnectionStatus("idle");
      setConnectedAccount(null);
    } catch {
      toast.error("Failed to remove credentials");
    }
  };

  if (isLoading) return null;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-blue-50 text-blue-600">
                <Video className="h-4 w-4" />
              </div>
              Zoom Integration
            </CardTitle>
            <CardDescription className="mt-1">
              Connect to Zoom for live meetings, webinars, and streaming within event sessions.
            </CardDescription>
          </div>
          {config?.configured && (
            <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200">
              Configured
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSave} className="space-y-5">
          {/* ── Server-to-Server OAuth ─────────────────────── */}
          <div>
            <p className="text-sm font-medium mb-3">Server-to-Server OAuth (for creating meetings)</p>
            <div className="grid gap-4 md:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="zoom-account-id">Account ID</Label>
                <Input
                  id="zoom-account-id"
                  value={displayAccountId}
                  onChange={(e) => setAccountId(e.target.value)}
                  placeholder="Zoom Account ID"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="zoom-client-id">Client ID</Label>
                <Input
                  id="zoom-client-id"
                  value={displayClientId}
                  onChange={(e) => setClientId(e.target.value)}
                  placeholder="OAuth Client ID"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="zoom-client-secret">Client Secret</Label>
                <Input
                  id="zoom-client-secret"
                  type="password"
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                  placeholder={config?.hasClientSecret ? "••••••••  (saved)" : "Client Secret"}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              Create a <strong>Server-to-Server OAuth</strong> app in the{" "}
              <a href="https://marketplace.zoom.us/develop/create" target="_blank" rel="noopener noreferrer" className="text-primary underline">
                Zoom App Marketplace
              </a>{" "}
              with scopes: <code>meeting:write:meeting:admin</code>, <code>meeting:read:meeting:admin</code>,{" "}
              <code>webinar:write:webinar:admin</code>, <code>webinar:read:webinar:admin</code>, <code>user:read:user:admin</code>.
            </p>
          </div>

          {/* ── Meeting SDK — Development ─────────────────── */}
          <div className="border-t pt-4">
            <p className="text-sm font-medium mb-3">Meeting SDK — Development (for local/test embedding)</p>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="zoom-sdk-key-dev">SDK Key (Client ID)</Label>
                <Input
                  id="zoom-sdk-key-dev"
                  value={displaySdkKeyDev}
                  onChange={(e) => setSdkKeyDev(e.target.value)}
                  placeholder="Dev Client ID"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="zoom-sdk-secret-dev">SDK Secret (Client Secret)</Label>
                <Input
                  id="zoom-sdk-secret-dev"
                  type="password"
                  value={sdkSecretDev}
                  onChange={(e) => setSdkSecretDev(e.target.value)}
                  placeholder={config?.hasSdkSecretDev ? "••••••••  (saved)" : "Dev Client Secret"}
                />
              </div>
            </div>
            {config?.hasSdkSecretDev && (
              <Badge variant="outline" className="mt-2 bg-green-50 text-green-700 border-green-200 text-xs">
                Dev SDK Saved
              </Badge>
            )}
          </div>

          {/* ── Meeting SDK — Production ──────────────────── */}
          <div className="border-t pt-4">
            <p className="text-sm font-medium mb-3">Meeting SDK — Production (for live domain)</p>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="zoom-sdk-key-prod">SDK Key (Client ID)</Label>
                <Input
                  id="zoom-sdk-key-prod"
                  value={displaySdkKeyProd}
                  onChange={(e) => setSdkKeyProd(e.target.value)}
                  placeholder="Prod Client ID"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="zoom-sdk-secret-prod">SDK Secret (Client Secret)</Label>
                <Input
                  id="zoom-sdk-secret-prod"
                  type="password"
                  value={sdkSecretProd}
                  onChange={(e) => setSdkSecretProd(e.target.value)}
                  placeholder={config?.hasSdkSecretProd ? "••••••••  (saved)" : "Prod Client Secret"}
                />
              </div>
            </div>
            {config?.hasSdkSecretProd && (
              <Badge variant="outline" className="mt-2 bg-green-50 text-green-700 border-green-200 text-xs">
                Prod SDK Saved
              </Badge>
            )}
          </div>

          {/* ── Active SDK Mode ───────────────────────────── */}
          <div className="border-t pt-4">
            <div className="flex items-center gap-4">
              <div className="space-y-2">
                <Label htmlFor="zoom-sdk-mode">Active SDK Mode</Label>
                <Select value={displaySdkMode} onValueChange={(v) => setSdkMode(v)}>
                  <SelectTrigger id="zoom-sdk-mode" className="w-[200px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="dev">Development</SelectItem>
                    <SelectItem value="prod">Production</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <p className="text-xs text-muted-foreground pt-6">
                Selects which Meeting SDK credentials to use for embedding. Use <strong>Development</strong> for local testing,
                switch to <strong>Production</strong> when going live.
              </p>
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            Create a <strong>General App</strong> in the Zoom Marketplace. Copy the Client ID and Client Secret
            from the App Credentials tab. Under the <strong>Embed</strong> tab, add <code>localhost</code> (for dev)
            and your production domain (e.g. <code>events.meetingmindsgroup.com</code>) to the allowed domains list.
          </p>

          {/* ── Actions ───────────────────────────────────── */}
          <div className="flex items-center gap-3 border-t pt-4">
            <Button type="submit" disabled={saveCredentials.isPending}>
              {saveCredentials.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              <Save className="mr-2 h-4 w-4" />
              Save Credentials
            </Button>
            {config?.configured && (
              <>
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleTestConnection}
                  disabled={testConnection.isPending}
                >
                  {testConnection.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Test Connection
                </Button>
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
              </>
            )}
            {connectionStatus === "success" && (
              <span className="flex items-center gap-1 text-sm text-green-600">
                <CheckCircle2 className="h-4 w-4" />
                {connectedAccount ? `Connected as ${connectedAccount}` : "Connected"}
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
