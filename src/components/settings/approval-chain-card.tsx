"use client";

/**
 * Settings → Roles: the spend request approval chain (Sep 28, 2026).
 *
 * Every spend request is approved by these people in order, whatever the
 * amount, the last one being the final approver; the purchase order is issued
 * after the last approval. One optional stand-in may decide the last level at
 * any time, and whoever approves a purchase never signs it off.
 *
 * SUPER ADMIN ONLY, enforced by the API. The save rules are the same pure
 * `validateChainConfig` the API runs, so the card explains a refusal before
 * the click rather than after it.
 */

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowDown, ListOrdered, Loader2, Plus, Trash2, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CHAIN_MAX_LEVELS, CHAIN_MIN_LEVELS, validateChainConfig, type ChainPerson } from "@/lib/approvals/approval-chain";

interface Candidate {
  id: string;
  name: string;
  role: string;
  approval: "unlimited" | "limited" | null;
  settles: boolean;
}

interface ChainResponse {
  chain: { levels: string[]; standInUserId: string | null } | null;
  candidates: Candidate[];
  updatedAt: string | null;
}

const QUERY_KEY = ["procurement", "approval-chain"] as const;
const NONE = "__none__";

function tag(c: Candidate): string {
  if (c.settles) return "finance sign-off";
  if (c.approval === "unlimited") return "unlimited approval";
  if (c.approval === "limited") return "approval limit";
  return "no approval access";
}

function toPeople(candidates: Candidate[]): ChainPerson[] {
  return candidates.map((c) => ({
    id: c.id,
    name: c.name,
    role: c.role,
    active: true,
    ceilingAed: c.approval === "unlimited" ? Number.POSITIVE_INFINITY : c.approval === "limited" ? 1 : null,
    settles: c.settles,
  }));
}

export function ApprovalChainCard() {
  const qc = useQueryClient();
  const { data, isLoading, isError } = useQuery<ChainResponse>({
    queryKey: QUERY_KEY,
    queryFn: async () => {
      const res = await fetch("/api/procurement/approval-chain");
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      return res.json();
    },
  });
  const [levels, setLevels] = useState<string[]>(["", ""]);
  const [standIn, setStandIn] = useState<string>("");
  const [saving, setSaving] = useState(false);

  // Load the saved chain into the form once it arrives (and after a save).
  useEffect(() => {
    if (!data) return;
    setLevels(data.chain?.levels.length ? data.chain.levels : ["", ""]);
    setStandIn(data.chain?.standInUserId ?? "");
  }, [data]);

  const candidates = useMemo(() => data?.candidates ?? [], [data]);
  const nameOf = (id: string) => candidates.find((c) => c.id === id)?.name ?? "someone no longer on the team";
  const filled = levels.every((l) => l !== "");
  const verdict = useMemo(
    () => (filled ? validateChainConfig({ levels, standInUserId: standIn || null }, toPeople(candidates)) : null),
    [filled, levels, standIn, candidates],
  );
  const saved = data?.chain ?? null;
  const dirty = JSON.stringify({ levels, standIn: standIn || null }) !== JSON.stringify({ levels: saved?.levels ?? ["", ""], standIn: saved?.standInUserId ?? null });

  async function put(body: { levels: string[]; standInUserId: string | null }, done: string) {
    setSaving(true);
    try {
      const res = await fetch("/api/procurement/approval-chain", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const out = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(out?.error || "Couldn't save the approval chain");
        return;
      }
      qc.setQueryData(QUERY_KEY, out);
      toast.success(done);
    } catch (error) {
      console.error("Error saving the approval chain:", error);
      toast.error("Couldn't save the approval chain");
    } finally {
      setSaving(false);
    }
  }

  const setLevel = (i: number, id: string) => setLevels((prev) => prev.map((l, j) => (j === i ? id : l)));
  // A new level goes in before the final approver, who stays last.
  const addLevel = () => setLevels((prev) => [...prev.slice(0, -1), "", prev[prev.length - 1]]);
  const removeLevel = (i: number) => setLevels((prev) => prev.filter((_, j) => j !== i));

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-sky-50 text-sky-600">
            <ListOrdered className="h-4 w-4" />
          </div>
          Spend request approval chain
          {saved ? <Badge variant="secondary" className="bg-emerald-100 text-emerald-900 dark:bg-emerald-900 dark:text-emerald-100">On</Badge> : <Badge variant="secondary">Off</Badge>}
        </CardTitle>
        <CardDescription>
          Every spend request is approved by these people in order, whatever the amount and whether or not it is over
          budget. The purchase order is issued after the last approval. Someone who raises a request skips their own
          level. Budgets and moves between budget lines keep the approval limits.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading && (
          <p className="text-sm text-muted-foreground flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading the chain…
          </p>
        )}
        {isError && <p className="text-sm text-destructive">Couldn&apos;t load the approval chain. Try again shortly.</p>}
        {data && (
          <>
            <ol className="space-y-2">
              {levels.map((id, i) => {
                const isFinal = i === levels.length - 1;
                return (
                  <li key={i} className="space-y-2">
                    <div className="flex flex-wrap items-end gap-2">
                      <div className="min-w-[16rem] flex-1 space-y-1">
                        <Label htmlFor={`chain-level-${i}`}>{isFinal ? `Level ${i + 1}: final approver` : `Level ${i + 1}`}</Label>
                        <Select value={id || undefined} onValueChange={(v) => setLevel(i, v)}>
                          <SelectTrigger id={`chain-level-${i}`}>
                            <SelectValue placeholder="Choose a person" />
                          </SelectTrigger>
                          <SelectContent>
                            {candidates.map((c) => {
                              const unusable = c.role === "SUPER_ADMIN" || c.settles || c.approval === null || (isFinal && c.approval !== "unlimited");
                              return (
                                <SelectItem key={c.id} value={c.id} disabled={unusable}>
                                  {`${c.name} · ${tag(c)}`}
                                </SelectItem>
                              );
                            })}
                          </SelectContent>
                        </Select>
                      </div>
                      {!isFinal && levels.length > CHAIN_MIN_LEVELS && (
                        <Button variant="ghost" size="sm" title="Remove this level" onClick={() => removeLevel(i)}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                    {!isFinal && <ArrowDown className="h-4 w-4 text-muted-foreground" aria-hidden="true" />}
                  </li>
                );
              })}
            </ol>
            {levels.length < CHAIN_MAX_LEVELS && (
              <Button variant="outline" size="sm" onClick={addLevel}>
                <Plus className="mr-2 h-4 w-4" /> Add a level before the final approver
              </Button>
            )}

            <div className="space-y-1 rounded-md border bg-muted/30 p-3">
              <Label htmlFor="chain-stand-in">Stand-in for the final approver (optional)</Label>
              <Select value={standIn || NONE} onValueChange={(v) => setStandIn(v === NONE ? "" : v)}>
                <SelectTrigger id="chain-stand-in">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>No stand-in</SelectItem>
                  {candidates.map((c) => (
                    <SelectItem key={c.id} value={c.id} disabled={c.role === "SUPER_ADMIN" || levels.includes(c.id)}>
                      {`${c.name} · ${tag(c)}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Can approve any request waiting on {levels[levels.length - 1] ? nameOf(levels[levels.length - 1]) : "the final approver"}, at any time.
                Whoever approves a purchase never confirms its delivery or signs off its budget; when the stand-in holds
                finance sign-off, the super admin signs off that budget instead.
              </p>
            </div>

            {verdict && !verdict.ok && (
              <p className="flex items-start gap-1.5 text-sm text-destructive">
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                {verdict.message}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Requests already waiting keep the chain they were submitted with; a change applies to new submissions.
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              {saved && (
                <Button variant="outline" disabled={saving} onClick={() => void put({ levels: [], standInUserId: null }, "Chain turned off. Spend requests go back to the approval limits.")}>
                  Turn off
                </Button>
              )}
              <Button disabled={saving || !filled || !verdict?.ok || !dirty} onClick={() => void put({ levels, standInUserId: standIn || null }, "Approval chain saved.")}>
                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Save chain
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
