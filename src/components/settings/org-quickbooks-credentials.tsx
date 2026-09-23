"use client";

/**
 * The Intuit app credentials FORM (September 22, 2026).
 *
 * Deliberately not a Card of its own: it renders inside the QuickBooks
 * card's "App credentials" disclosure, because every other integration on
 * Settings, Integrations is a single card, and credentials are set once and
 * then never touched while the connection beside them is looked at often.
 *
 * A sandbox pair and a production pair are held side by side with a toggle
 * for which is live. A client secret is write-only: the server never
 * returns one, so a saved secret shows as a placeholder and leaving the
 * field blank keeps it, which is what makes editing a client id safe.
 */

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Save, Copy, Trash2, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { useQuickBooksApp, useSaveQuickBooksApp, useClearQuickBooksApp, type QuickBooksAppView } from "@/hooks/use-api";

type Env = "sandbox" | "production";

interface PairDraft {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

function draftFrom(view: QuickBooksAppView | undefined, env: Env, fallbackRedirect: string): PairDraft {
  const pair = view?.[env];
  return {
    clientId: pair?.clientId ?? "",
    clientSecret: "",
    redirectUri: pair?.redirectUri ?? fallbackRedirect,
  };
}

export function QuickBooksCredentialsForm() {
  const { data, isLoading, refetch } = useQuickBooksApp();
  const save = useSaveQuickBooksApp();
  const clear = useClearQuickBooksApp();

  const [tab, setTab] = useState<Env | null>(null);
  const [drafts, setDrafts] = useState<Partial<Record<Env, PairDraft>>>({});

  const app = data?.app;
  // The live environment is the tab that opens first; a click overrides it.
  // Derived rather than synced in an effect, so a background refetch cannot
  // reset a half-typed form.
  const active: Env = tab ?? app?.environment ?? "sandbox";
  const draft = drafts[active] ?? draftFrom(app, active, data?.suggestedRedirectUri ?? "");

  const setField = (field: keyof PairDraft, value: string) =>
    setDrafts((d) => ({ ...d, [active]: { ...draft, [field]: value } }));

  const handleSave = async () => {
    try {
      await save.mutateAsync({
        [active]: {
          clientId: draft.clientId.trim(),
          // Blank means "leave the stored secret alone", which is why it is omitted rather than sent empty.
          ...(draft.clientSecret.trim() ? { clientSecret: draft.clientSecret.trim() } : {}),
          redirectUri: draft.redirectUri.trim(),
        },
      });
      // Drop the local draft so the saved values become the source of truth again.
      setDrafts((d) => ({ ...d, [active]: undefined }));
      toast.success(`Saved the ${active} credentials`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save the credentials");
    }
  };

  const handleUseEnvironment = async () => {
    try {
      await save.mutateAsync({ environment: active });
      toast.success(`QuickBooks is now using the ${active} app`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not switch environment");
    }
  };

  const handleClear = async () => {
    if (!confirm(`Remove the ${active} client id, secret and redirect URI? An existing connection made with them stops working.`)) return;
    try {
      await clear.mutateAsync(active);
      setDrafts((d) => ({ ...d, [active]: undefined }));
      toast.success(`Removed the ${active} credentials`);
      void refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not remove the credentials");
    }
  };

  const copyRedirect = async () => {
    try {
      await navigator.clipboard.writeText(draft.redirectUri);
      toast.success("Redirect URI copied. Paste it into the Intuit app.");
    } catch {
      toast.error("Could not copy. Select the field and copy manually.");
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading credentials…
      </div>
    );
  }

  const isLive = app?.environment === active;
  const savedPair = app?.[active];

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        The Intuit app this organisation connects through. Create one at the Intuit developer portal, then paste its
        keys here and register the redirect URI below against the same app.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        {(["sandbox", "production"] as const).map((env) => (
          <Button key={env} type="button" size="sm" variant={active === env ? "default" : "outline"} onClick={() => setTab(env)}>
            {env === "sandbox" ? "Development (sandbox)" : "Production"}
            {app?.[env]?.clientId && <span className="ml-2 text-xs opacity-70">set</span>}
          </Button>
        ))}
        {!isLive && (
          <span className="text-xs text-muted-foreground">
            Editing the {active} app; {app?.environment ?? "sandbox"} is currently live.
          </span>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`qb-client-id-${active}`}>Client ID</Label>
          <Input
            id={`qb-client-id-${active}`}
            value={draft.clientId}
            onChange={(e) => setField("clientId", e.target.value)}
            placeholder="ABxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
            autoComplete="off"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`qb-client-secret-${active}`}>Client Secret</Label>
          <Input
            id={`qb-client-secret-${active}`}
            type="password"
            value={draft.clientSecret}
            onChange={(e) => setField("clientSecret", e.target.value)}
            placeholder={savedPair?.hasClientSecret ? "•••••••• (saved; leave blank to keep)" : "Paste the client secret"}
            autoComplete="new-password"
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor={`qb-redirect-${active}`}>Redirect URI (callback URL)</Label>
        <div className="flex gap-2">
          <Input
            id={`qb-redirect-${active}`}
            value={draft.redirectUri}
            onChange={(e) => setField("redirectUri", e.target.value)}
            placeholder="https://events.example.com/api/integrations/quickbooks/callback"
            autoComplete="off"
            className="font-mono text-xs"
          />
          <Button type="button" variant="outline" size="icon" onClick={copyRedirect} title="Copy">
            <Copy className="h-4 w-4" />
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          This must match the Redirect URI registered on the Intuit app <em>exactly</em>, character for character. In the
          Intuit console it is under Settings → Redirect URIs. Development URIs may be http, production must be https.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={handleSave} disabled={save.isPending}>
          {save.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
          Save {active} credentials
        </Button>
        {!isLive && (
          <Button variant="outline" onClick={handleUseEnvironment} disabled={save.isPending}>
            Use the {active} app
          </Button>
        )}
        {(savedPair?.clientId || savedPair?.hasClientSecret) && (
          <Button variant="outline" onClick={handleClear} disabled={clear.isPending}>
            {clear.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
            Remove
          </Button>
        )}
        <Button asChild variant="ghost" size="sm">
          <a href="https://developer.intuit.com/app/developer/dashboard" target="_blank" rel="noopener noreferrer">
            Intuit developer portal <ExternalLink className="ml-1 h-3 w-3" />
          </a>
        </Button>
      </div>

      {isLive && !app?.ready && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          The {active} app is missing one of its three fields, so Connect stays unavailable. All of client id, client
          secret and redirect URI are needed.
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Changing these after connecting invalidates that connection: the tokens were issued to the old app. The status
        above will say so and offer a reconnect.
      </p>
    </div>
  );
}
