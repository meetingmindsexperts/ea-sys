"use client";

/**
 * Settings → Approvals: the approval chains (Sep 28, 2026).
 *
 *   Spend requests   2 to 4 people in order, whatever the amount, the last the
 *                    final approver; the order is issued after the last
 *                    approval. An optional stand-in may decide the last level.
 *   Budgets          one approver for an event's budget, its new versions and
 *                    moves between its lines, whatever the amount, with an
 *                    optional backup who may decide in their place.
 *
 * SUPER ADMIN ONLY, enforced by the API. The save rules are the same pure
 * `validateChainConfig` the API runs, so the card explains a refusal before
 * the click rather than after it.
 */

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowDown, ListOrdered, Loader2, Plus, Trash2, TriangleAlert, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CHAIN_RULES, validateChainConfig, type ChainKind, type ChainPerson } from "@/lib/approvals/approval-chain";

interface Candidate {
  id: string;
  name: string;
  role: string;
  approval: "unlimited" | "limited" | null;
  settles: boolean;
  procurementAccess: boolean;
}

type Chain = { levels: string[]; standInUserId: string | null } | null;

interface ChainResponse {
  chains: Record<ChainKind, Chain>;
  candidates: Candidate[];
}

const QUERY_KEY = ["procurement", "approval-chain"] as const;
const NONE = "__none__";

function tag(c: Candidate): string {
  if (c.settles) return "finance sign-off";
  if (c.approval === "unlimited") return "unlimited approval";
  if (c.approval === "limited") return "approval limit";
  return c.procurementAccess ? "no approval access" : "no Budgets access";
}

function toPeople(candidates: Candidate[]): ChainPerson[] {
  return candidates.map((c) => ({
    id: c.id,
    name: c.name,
    role: c.role,
    active: true,
    ceilingAed: c.approval === "unlimited" ? Number.POSITIVE_INFINITY : c.approval === "limited" ? 1 : null,
    settles: c.settles,
    hasProcurementAccess: c.procurementAccess,
  }));
}

export function ApprovalChainCard() {
  const { data, isLoading, isError } = useQuery<ChainResponse>({
    queryKey: QUERY_KEY,
    queryFn: async () => {
      const res = await fetch("/api/procurement/approval-chain");
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      return res.json();
    },
  });

  return (
    <div className="space-y-6">
      <Card className="overflow-hidden pt-0">
        <CardHeader className="border-b bg-gradient-to-r from-primary/10 via-primary/5 to-transparent pt-6 pb-5">
          <CardTitle className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-primary/15 text-primary">
              <ListOrdered className="h-4 w-4" />
            </div>
            Spend request approval chain
            <OnOff on={!!data?.chains.SPEND_REQUEST} />
          </CardTitle>
          <CardDescription>
            Every spend request is approved by these people in order, whatever the amount and whether or not it is over
            budget. The purchase order is issued after the last approval. Someone who raises a request skips their own
            level.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Loading isLoading={isLoading} isError={isError} />
          {data && <ChainEditor kind="SPEND_REQUEST" saved={data.chains.SPEND_REQUEST} candidates={data.candidates} />}
        </CardContent>
      </Card>

      <Card className="overflow-hidden pt-0">
        <CardHeader className="border-b bg-gradient-to-r from-primary/10 via-primary/5 to-transparent pt-6 pb-5">
          <CardTitle className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-primary/15 text-primary">
              <Wallet className="h-4 w-4" />
            </div>
            Budget approver
            <OnOff on={!!data?.chains.BUDGET} />
          </CardTitle>
          <CardDescription>
            Approves every event budget, its new versions, and moves between its lines, whatever the amount. The backup
            can decide in their place at any time.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Loading isLoading={isLoading} isError={isError} />
          {data && <ChainEditor kind="BUDGET" saved={data.chains.BUDGET} candidates={data.candidates} />}
        </CardContent>
      </Card>
    </div>
  );
}

function OnOff({ on }: { on: boolean }) {
  return on ? (
    <Badge variant="secondary" className="bg-emerald-100 text-emerald-900 dark:bg-emerald-900 dark:text-emerald-100">On</Badge>
  ) : (
    <Badge variant="secondary">Off</Badge>
  );
}

function Loading({ isLoading, isError }: { isLoading: boolean; isError: boolean }) {
  if (isLoading) {
    return (
      <p className="text-sm text-muted-foreground flex items-center gap-2">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </p>
    );
  }
  if (isError) return <p className="text-sm text-destructive">Couldn&apos;t load the approval settings. Try again shortly.</p>;
  return null;
}

function ChainEditor({ kind, saved, candidates }: { kind: ChainKind; saved: Chain; candidates: Candidate[] }) {
  const qc = useQueryClient();
  const rules = CHAIN_RULES[kind];
  const empty = useMemo(() => Array.from({ length: rules.minLevels }, () => ""), [rules.minLevels]);
  const [levels, setLevels] = useState<string[]>(empty);
  const [standIn, setStandIn] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const isBudget = kind === "BUDGET";
  const prefix = isBudget ? "budget-approver" : "chain-level";

  // Load the saved chain into the form when it arrives or changes (after a save).
  const savedKey = JSON.stringify(saved);
  useEffect(() => {
    setLevels(saved?.levels.length ? saved.levels : empty);
    setStandIn(saved?.standInUserId ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey, empty]);

  const nameOf = (id: string) => candidates.find((c) => c.id === id)?.name ?? "someone no longer on the team";
  const filled = levels.every((l) => l !== "");
  const verdict = useMemo(
    () => (filled ? validateChainConfig({ levels, standInUserId: standIn || null }, toPeople(candidates), kind) : null),
    [filled, levels, standIn, candidates, kind],
  );
  const dirty = JSON.stringify({ levels, standIn: standIn || null }) !== JSON.stringify({ levels: saved?.levels ?? empty, standIn: saved?.standInUserId ?? null });

  async function put(body: { levels: string[]; standInUserId: string | null }, done: string) {
    setSaving(true);
    try {
      const res = await fetch("/api/procurement/approval-chain", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, ...body }),
      });
      const out = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(out?.error || "Couldn't save");
        return;
      }
      qc.setQueryData(QUERY_KEY, out);
      toast.success(done);
    } catch (error) {
      console.error("Error saving the approval chain:", error);
      toast.error("Couldn't save");
    } finally {
      setSaving(false);
    }
  }

  const setLevel = (i: number, id: string) => setLevels((prev) => prev.map((l, j) => (j === i ? id : l)));
  // A new level goes in before the final approver, who stays last.
  const addLevel = () => setLevels((prev) => [...prev.slice(0, -1), "", prev[prev.length - 1]]);
  const removeLevel = (i: number) => setLevels((prev) => prev.filter((_, j) => j !== i));
  const finalName = levels[levels.length - 1] ? nameOf(levels[levels.length - 1]) : isBudget ? "the budget approver" : "the final approver";

  return (
    <div className="space-y-4">
      <ol className="space-y-2">
        {levels.map((id, i) => {
          const isFinal = i === levels.length - 1;
          const label = isBudget ? "Approver" : isFinal ? `Level ${i + 1}: final approver` : `Level ${i + 1}`;
          return (
            <li key={i} className="space-y-2">
              <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/50 p-3">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-sm font-semibold text-primary tabular-nums" aria-hidden="true">{isBudget ? "✓" : i + 1}</span>
                <div className="min-w-[14rem] flex-1 space-y-1">
                  <Label htmlFor={`${prefix}-${i}`}>{label}</Label>
                  <Select value={id || undefined} onValueChange={(v) => setLevel(i, v)}>
                    <SelectTrigger id={`${prefix}-${i}`} className="w-full sm:max-w-md">
                      <SelectValue placeholder="Choose a person" />
                    </SelectTrigger>
                    <SelectContent>
                      {candidates.map((c) => {
                        const unusable = c.role === "SUPER_ADMIN" || c.settles || c.approval === null || (rules.finalUnlimited && isFinal && c.approval !== "unlimited");
                        return (
                          <SelectItem key={c.id} value={c.id} disabled={unusable}>
                            {`${c.name} · ${tag(c)}`}
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                </div>
                {!isFinal && levels.length > rules.minLevels && (
                  <Button variant="ghost" size="sm" title="Remove this level" onClick={() => removeLevel(i)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
              {!isFinal && <ArrowDown className="ml-5 h-4 w-4 text-primary/60" aria-hidden="true" />}
            </li>
          );
        })}
      </ol>
      {levels.length < rules.maxLevels && (
        <Button variant="outline" size="sm" onClick={addLevel}>
          <Plus className="mr-2 h-4 w-4" /> Add a level before the final approver
        </Button>
      )}

      <div className="space-y-1 rounded-lg border border-primary/25 bg-primary/5 p-3">
        <Label htmlFor={`${prefix}-stand-in`}>{isBudget ? "Backup (optional)" : "Stand-in for the final approver (optional)"}</Label>
        <Select value={standIn || NONE} onValueChange={(v) => setStandIn(v === NONE ? "" : v)}>
          <SelectTrigger id={`${prefix}-stand-in`} className="w-full sm:max-w-md">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>{isBudget ? "No backup" : "No stand-in"}</SelectItem>
            {candidates.map((c) => (
              <SelectItem key={c.id} value={c.id} disabled={c.role === "SUPER_ADMIN" || levels.includes(c.id) || !c.procurementAccess}>
                {`${c.name} · ${tag(c)}`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          {isBudget
            ? `Can decide any budget or move waiting on ${finalName}, at any time.`
            : `Can approve any request waiting on ${finalName}, at any time. When someone both approves a purchase and later confirms its delivery or signs off its budget, it is allowed and shown on the order and the close-out.`}
        </p>
      </div>

      {verdict && !verdict.ok && (
        <p className="flex items-start gap-1.5 text-sm text-destructive">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          {verdict.message}
        </p>
      )}
      <p className="rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
        Requests already waiting keep the approvers they were submitted with; a change applies to new submissions. Removing
        a {isBudget ? "backup" : "stand-in"} takes effect at once.
      </p>
      <div className="flex flex-wrap justify-end gap-2">
        {saved && (
          <Button
            variant="outline"
            disabled={saving}
            onClick={() => void put({ levels: [], standInUserId: null }, isBudget ? "Turned off. Budgets go back to the approval limits." : "Chain turned off. Spend requests go back to the approval limits.")}
          >
            Turn off
          </Button>
        )}
        <Button disabled={saving || !filled || !verdict?.ok || !dirty} onClick={() => void put({ levels, standInUserId: standIn || null }, isBudget ? "Budget approver saved." : "Approval chain saved.")}>
          {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {isBudget ? "Save budget approver" : "Save chain"}
        </Button>
      </div>
    </div>
  );
}
