"use client";

import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
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
  const [sdkKey, setSdkKey] = useState<string | null>(null);
  const [sdkSecret, setSdkSecret] = useState("");
  const [connectionStatus, setConnectionStatus] = useState<"idle" | "success" | "error">("idle");
  const [connectedAccount, setConnectedAccount] = useState<string | null>(null);

  const displayAccountId = accountId ?? config?.accountId ?? "";
  const displayClientId = clientId ?? config?.clientId ?? "";
  const displaySdkKey = sdkKey ?? config?.sdkKey ?? "";

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!displayAccountId.trim() || !displayClientId.trim() || !clientSecret.trim()) {
      toast.error("All three fields are required");
      return;
    }
    try {
      await saveCredentials.mutateAsync({
        accountId: displayAccountId.trim(),
        clientId: displayClientId.trim(),
        clientSecret: clientSecret.trim(),
        ...(displaySdkKey.trim() && { sdkKey: displaySdkKey.trim() }),
        ...(sdkSecret.trim() && { sdkSecret: sdkSecret.trim() }),
      });
      toast.success("Zoom credentials saved");
      setClientSecret("");
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
        <form onSubmit={handleSave} className="space-y-4">
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
                placeholder="Server-to-Server OAuth Client ID"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="zoom-client-secret">Client Secret</Label>
              <Input
                id="zoom-client-secret"
                type="password"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                placeholder={config?.configured ? "••••••••••••" : "Client Secret"}
              />
            </div>
          </div>

          <div className="text-xs text-muted-foreground">
            <strong>Step 1:</strong> Create a <strong>Server-to-Server OAuth</strong> app in the{" "}
            <a
              href="https://marketplace.zoom.us/develop/create"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline"
            >
              Zoom App Marketplace
            </a>{" "}
            with scopes: <code>meeting:write:meeting:admin</code>, <code>meeting:read:meeting:admin</code>,{" "}
            <code>webinar:write:webinar:admin</code>, <code>webinar:read:webinar:admin</code>, <code>user:read:user:admin</code>.
          </div>

          {/* Meeting SDK credentials */}
          <div className="border-t pt-4 mt-2">
            <p className="text-sm font-medium mb-3">Meeting SDK (embed meetings in browser)</p>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="zoom-sdk-key">SDK Key (Client ID)</Label>
                <Input
                  id="zoom-sdk-key"
                  value={displaySdkKey}
                  onChange={(e) => setSdkKey(e.target.value)}
                  placeholder="Meeting SDK Client ID"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="zoom-sdk-secret">SDK Secret (Client Secret)</Label>
                <Input
                  id="zoom-sdk-secret"
                  type="password"
                  value={sdkSecret}
                  onChange={(e) => setSdkSecret(e.target.value)}
                  placeholder={config?.sdkKeyConfigured ? "••••••••••••" : "Meeting SDK Client Secret"}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              <strong>Step 2:</strong> Create a <strong>Meeting SDK</strong> app in the Zoom App Marketplace.
              Copy the Client ID and Client Secret here. Add your domain (e.g. <code>events.meetingmindsgroup.com</code>) to the
              app&apos;s allowed domains list. Without this, meetings will open in the Zoom app instead of embedding in the browser.
            </p>
            {config?.sdkKeyConfigured && (
              <Badge variant="outline" className="mt-2 bg-green-50 text-green-700 border-green-200 text-xs">
                SDK Configured
              </Badge>
            )}
          </div>

          <div className="flex items-center gap-3">
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
