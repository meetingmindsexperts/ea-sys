"use client";

import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Save, CheckCircle2, XCircle, Sparkles, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  useAiCredentials,
  useSaveAiCredentials,
  useDeleteAiCredentials,
  useTestAiConnection,
  type AiProviderCredentialState,
} from "@/hooks/use-api";

type ProviderName = "anthropic" | "openai";

/**
 * Org AI credentials card (Settings → Integrations; per-tenant keys, item 7).
 * One card for both providers because the Help Chat provider choice spans
 * them. Same masking model as the Zoom card: keys live in empty local state
 * with a "(saved)" placeholder; blank fields are omitted from the payload.
 */
export function OrgAiCredentials() {
  const { data: config, isLoading } = useAiCredentials();
  const saveCredentials = useSaveAiCredentials();
  const deleteCredentials = useDeleteAiCredentials();
  const testConnection = useTestAiConnection();

  const [helpChatProvider, setHelpChatProvider] = useState<ProviderName | null>(null);
  const [anthropicApiKey, setAnthropicApiKey] = useState("");
  const [openaiApiKey, setOpenaiApiKey] = useState("");
  const [testState, setTestState] = useState<Partial<Record<ProviderName, "success" | "error">>>({});

  const displayProvider = helpChatProvider ?? config?.helpChatProvider ?? "anthropic";

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const payload = {
      ...(helpChatProvider && helpChatProvider !== config?.helpChatProvider && { helpChatProvider }),
      ...(anthropicApiKey.trim() && { anthropicApiKey: anthropicApiKey.trim() }),
      ...(openaiApiKey.trim() && { openaiApiKey: openaiApiKey.trim() }),
    };
    if (Object.keys(payload).length === 0) {
      toast.error("Nothing to save — enter a key or change the provider");
      return;
    }
    try {
      await saveCredentials.mutateAsync(payload);
      toast.success("AI settings saved");
      setAnthropicApiKey("");
      setOpenaiApiKey("");
      setTestState({});
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save AI settings");
    }
  };

  const handleTest = async (provider: ProviderName) => {
    setTestState((s) => ({ ...s, [provider]: undefined }));
    try {
      const result = await testConnection.mutateAsync({ provider });
      if (result.success) {
        setTestState((s) => ({ ...s, [provider]: "success" }));
        toast.success(
          `${provider === "openai" ? "OpenAI" : "Anthropic"} connection successful (${result.source === "org" ? "this organization's key" : "platform default key"})`,
        );
      } else {
        setTestState((s) => ({ ...s, [provider]: "error" }));
        toast.error(result.error || "Connection failed");
      }
    } catch (err) {
      setTestState((s) => ({ ...s, [provider]: "error" }));
      toast.error(err instanceof Error ? err.message : "Connection test failed");
    }
  };

  const handleDelete = async (provider: ProviderName) => {
    if (!window.confirm(`Remove this organization's ${provider === "openai" ? "OpenAI" : "Anthropic"} key? Features fall back to the platform default key.`)) {
      return;
    }
    try {
      await deleteCredentials.mutateAsync({ provider });
      toast.success("Key removed");
      setTestState((s) => ({ ...s, [provider]: undefined }));
      setHelpChatProvider(null);
    } catch {
      toast.error("Failed to remove the key");
    }
  };

  if (isLoading) return null;

  const providerSection = (
    provider: ProviderName,
    label: string,
    placeholder: string,
    state: AiProviderCredentialState | undefined,
    value: string,
    setValue: (v: string) => void,
  ) => (
    <div className="border-t pt-4">
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm font-medium">{label}</p>
        {state?.configured && (
          <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200 text-xs">
            Key saved
          </Badge>
        )}
      </div>
      <div className="flex items-end gap-2">
        <div className="flex-1 space-y-2">
          <Label htmlFor={`ai-key-${provider}`}>API Key</Label>
          <Input
            id={`ai-key-${provider}`}
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={
              state?.configured
                ? `••••••••${state.apiKeyLast4 ?? ""}  (saved)`
                : placeholder
            }
          />
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={() => handleTest(provider)}
          disabled={testConnection.isPending}
        >
          {testConnection.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Test
        </Button>
        {state?.configured && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-red-600 hover:text-red-700 hover:bg-red-50"
            onClick={() => handleDelete(provider)}
            disabled={deleteCredentials.isPending}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
        {testState[provider] === "success" && (
          <span className="flex items-center pb-2 text-green-600">
            <CheckCircle2 className="h-4 w-4" />
          </span>
        )}
        {testState[provider] === "error" && (
          <span className="flex items-center pb-2 text-red-600">
            <XCircle className="h-4 w-4" />
          </span>
        )}
      </div>
      {!state?.configured && state?.envFallbackAvailable && (
        <p className="text-xs text-muted-foreground mt-2">
          No organization key set — currently using the platform default key.
        </p>
      )}
    </div>
  );

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-cyan-50 text-cyan-600">
                <Sparkles className="h-4 w-4" />
              </div>
              AI Assistant
            </CardTitle>
            <CardDescription className="mt-1">
              Bring your organization&apos;s own AI keys and choose which provider powers the Help Assistant.
            </CardDescription>
          </div>
          {(config?.anthropic.configured || config?.openai.configured) && (
            <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200">
              Configured
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSave} className="space-y-5">
          <div className="flex items-center gap-4">
            <div className="space-y-2">
              <Label htmlFor="ai-help-chat-provider">Help Assistant provider</Label>
              <Select value={displayProvider} onValueChange={(v) => setHelpChatProvider(v as ProviderName)}>
                <SelectTrigger id="ai-help-chat-provider" className="w-[200px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="anthropic">Anthropic (Claude)</SelectItem>
                  <SelectItem value="openai">OpenAI (GPT)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <p className="text-xs text-muted-foreground pt-6">
              The in-app Event Agent always runs on Anthropic — it needs an Anthropic key (yours or the
              platform default), with web search enabled in that Anthropic Console.
            </p>
          </div>

          {providerSection(
            "anthropic",
            "Anthropic (Claude)",
            "sk-ant-…",
            config?.anthropic,
            anthropicApiKey,
            setAnthropicApiKey,
          )}
          {providerSection(
            "openai",
            "OpenAI (GPT)",
            "sk-…",
            config?.openai,
            openaiApiKey,
            setOpenaiApiKey,
          )}

          <div className="flex items-center gap-3 border-t pt-4">
            <Button type="submit" disabled={saveCredentials.isPending}>
              {saveCredentials.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              <Save className="mr-2 h-4 w-4" />
              Save AI Settings
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
