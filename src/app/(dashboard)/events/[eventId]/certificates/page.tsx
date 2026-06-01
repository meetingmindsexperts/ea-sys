"use client";

/**
 * Certificates page — Phase A.
 *
 * Two cards:
 *   1. CME Settings — cmeHours + per-event accreditations (multi) + a
 *      SUPER_ADMIN-only "Design approved" checkbox that gates the Phase C
 *      issue button.
 *   2. Preview — render any of the four cert types as a PDF in an iframe.
 *      This is the CEO/MD review surface.
 *
 * Phase C will add Tabs (Attendance / Presenter / Poster / CME) above this
 * with eligibility lists + Issue buttons. The current page is one route
 * that evolves rather than two routes that overlap.
 */

import { useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  GraduationCap,
  Plus,
  Trash2,
  Save,
  Eye,
  Info,
  Lock,
  CheckCircle2,
} from "lucide-react";

type CertType = "ATTENDANCE" | "PRESENTER" | "POSTER" | "CME";

const ACCREDITOR_BODIES = ["DHA", "DOH", "SCFHS", "EACCME", "ACCME", "OTHER"] as const;
type AccreditorBody = (typeof ACCREDITOR_BODIES)[number];

interface AccreditationRow {
  body: AccreditatorBodyOrEmpty;
  reference: string;
  hours?: number;
  officialStatement?: string;
}
// Allow "" only at edit time so the Select can render the placeholder
// state. Validated to a real body before PATCH.
type AccreditatorBodyOrEmpty = AccreditorBody | "";

interface SettingsResponse {
  cmeHours: number | null;
  accreditations: AccreditationRow[];
  designApprovedBy: string | null;
  designApprovedAt: string | null;
}

export default function CertificatesPage() {
  const { eventId } = useParams<{ eventId: string }>();
  const queryClient = useQueryClient();
  const { data: session } = useSession();
  const isSuperAdmin = session?.user?.role === "SUPER_ADMIN";

  const [draft, setDraft] = useState<SettingsResponse | null>(null);
  const [previewType, setPreviewType] = useState<CertType>("ATTENDANCE");
  const [previewBust, setPreviewBust] = useState(0); // forces iframe reload on re-render
  const [previewVisible, setPreviewVisible] = useState(false);
  const [previewProbe, setPreviewProbe] = useState<
    | { kind: "idle" }
    | { kind: "probing" }
    | { kind: "ok"; bytes: number }
    | { kind: "http-error"; status: number; body: string }
    | { kind: "network-error"; message: string }
  >({ kind: "idle" });

  const settingsQuery = useQuery<SettingsResponse>({
    queryKey: ["cert-settings", eventId],
    queryFn: async () => {
      const res = await fetch(`/api/events/${eventId}/certificates/settings`);
      if (!res.ok) throw new Error(`Failed to load settings (${res.status})`);
      const json = (await res.json()) as SettingsResponse;
      // Seed the local draft from the server on first load — afterwards the
      // user edits the draft locally and only writes back on Save.
      setDraft((current) => current ?? json);
      return json;
    },
  });

  const saveMutation = useMutation({
    mutationFn: async (body: Partial<SettingsResponse> & { designApproved?: boolean }) => {
      const res = await fetch(`/api/events/${eventId}/certificates/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || `Save failed (${res.status})`);
      }
      return (await res.json()) as SettingsResponse;
    },
    onSuccess: (data) => {
      setDraft(data);
      queryClient.setQueryData(["cert-settings", eventId], data);
      toast.success("Certificate settings saved");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const dirty = useMemo(() => {
    if (!draft || !settingsQuery.data) return false;
    return JSON.stringify(draft) !== JSON.stringify(settingsQuery.data);
  }, [draft, settingsQuery.data]);

  const editable = draft ?? settingsQuery.data ?? null;

  function updateDraft(patch: Partial<SettingsResponse>) {
    setDraft((cur) => ({ ...(cur ?? settingsQuery.data!), ...patch }));
  }

  function addAccreditation() {
    if (!editable) return;
    const next: AccreditationRow = { body: "", reference: "" };
    updateDraft({ accreditations: [...editable.accreditations, next] });
  }

  function removeAccreditation(idx: number) {
    if (!editable) return;
    updateDraft({
      accreditations: editable.accreditations.filter((_, i) => i !== idx),
    });
  }

  function updateAccreditation(idx: number, patch: Partial<AccreditationRow>) {
    if (!editable) return;
    updateDraft({
      accreditations: editable.accreditations.map((a, i) =>
        i === idx ? { ...a, ...patch } : a,
      ),
    });
  }

  async function onSave() {
    if (!editable) return;
    // Strip empty-body rows before send — they'd fail server-side Zod and
    // produce a confusing error. Better to silently drop, matching how
    // sponsors page handles incomplete rows on save.
    const cleanedAccreditations = editable.accreditations
      .filter((a) => a.body !== "" && a.reference.trim().length > 0)
      .map((a) => ({
        body: a.body as AccreditorBody,
        reference: a.reference.trim(),
        hours: a.hours,
        officialStatement: a.officialStatement?.trim() || undefined,
      }));
    saveMutation.mutate({
      cmeHours: editable.cmeHours,
      accreditations: cleanedAccreditations,
    });
  }

  async function toggleApproval(approved: boolean) {
    if (!isSuperAdmin) return;
    saveMutation.mutate({ designApproved: approved });
  }

  async function showPreview() {
    setPreviewVisible(true);
    setPreviewBust((b) => b + 1);

    // BACKGROUND PROBE: fetch the same URL the iframe uses to surface any
    // server-side failure (500, 404, 429, 403) that an iframe would
    // otherwise hide behind a generic "refused to connect". Adds zero
    // delay to the iframe (it loads in parallel) but means a broken
    // response shows a real error message in the UI + console instead of
    // a silent blank frame. Same-origin → no CORS concerns.
    setPreviewProbe({ kind: "probing" });
    try {
      const res = await fetch(
        `/api/events/${eventId}/certificates/preview?type=${previewType}&t=${Date.now()}`,
      );
      if (!res.ok) {
        const body = await res.text().catch(() => "(no body)");
        setPreviewProbe({ kind: "http-error", status: res.status, body });
        toast.error(`Preview failed: HTTP ${res.status}. Check /logs.`);
        console.error("[cert-preview] HTTP error", { status: res.status, body });
        return;
      }
      const buf = await res.arrayBuffer();
      setPreviewProbe({ kind: "ok", bytes: buf.byteLength });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setPreviewProbe({ kind: "network-error", message });
      toast.error(`Preview network failure: ${message}`);
      console.error("[cert-preview] Network error", e);
    }
  }

  const previewSrc = `/api/events/${eventId}/certificates/preview?type=${previewType}&t=${previewBust}`;

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center gap-3">
        <GraduationCap className="h-7 w-7 text-primary" />
        <div>
          <h1 className="text-2xl font-bold">Certificates</h1>
          <p className="text-sm text-muted-foreground">
            Phase A — review certificate designs with the CEO/MD before issuing. No
            certificates are actually issued from this page in v1.
          </p>
        </div>
      </div>

      {/* ── CME Settings ─────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>CME / CPD configuration</CardTitle>
          <CardDescription>
            Set the per-event hours awarded and the accrediting bodies. The CME
            certificate template reads from here.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid gap-2 max-w-xs">
            <Label htmlFor="cmeHours">Total CME / CPD hours awarded</Label>
            <Input
              id="cmeHours"
              type="number"
              step="0.5"
              min="0"
              max="999.9"
              placeholder="e.g. 18.0"
              value={editable?.cmeHours ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                updateDraft({ cmeHours: v === "" ? null : Number(v) });
              }}
            />
            <p className="text-xs text-muted-foreground">
              Leave empty if this event is not CME-accredited.
            </p>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <Label>Accreditations</Label>
                <p className="text-xs text-muted-foreground">
                  Add one row per accrediting body. Events can carry multiple
                  (e.g. DHA + EACCME) — each renders as its own line on the CME
                  certificate.
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={addAccreditation}
                disabled={!editable}
              >
                <Plus className="h-4 w-4 mr-1" /> Add accreditation
              </Button>
            </div>

            {editable?.accreditations.length === 0 && (
              <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                No accreditations yet — add one above to enable the CME certificate.
              </div>
            )}

            {editable?.accreditations.map((row, idx) => (
              <div
                key={idx}
                className="grid gap-3 rounded-md border p-3 md:grid-cols-[180px_1fr_120px_auto]"
              >
                <div>
                  <Label className="text-xs">Body</Label>
                  <Select
                    value={row.body}
                    onValueChange={(v) =>
                      updateAccreditation(idx, { body: v as AccreditorBody })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Pick accreditor" />
                    </SelectTrigger>
                    <SelectContent>
                      {ACCREDITOR_BODIES.map((b) => (
                        <SelectItem key={b} value={b}>
                          {b}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs">Reference</Label>
                  <Input
                    placeholder="e.g. DHA-CPD-2026-0142"
                    value={row.reference}
                    onChange={(e) =>
                      updateAccreditation(idx, { reference: e.target.value })
                    }
                  />
                </div>
                <div>
                  <Label className="text-xs">Hours (override)</Label>
                  <Input
                    type="number"
                    step="0.5"
                    placeholder="default"
                    value={row.hours ?? ""}
                    onChange={(e) =>
                      updateAccreditation(idx, {
                        hours: e.target.value === "" ? undefined : Number(e.target.value),
                      })
                    }
                  />
                </div>
                <div className="flex items-end">
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => removeAccreditation(idx)}
                  >
                    <Trash2 className="h-4 w-4 text-red-500" />
                  </Button>
                </div>
                <div className="md:col-span-4">
                  <Label className="text-xs">
                    Official statement (override) — only if the accreditor requires
                    verbatim wording
                  </Label>
                  <Textarea
                    rows={2}
                    placeholder="e.g. This activity has been designated for a maximum of 18.0 European CME credits (ECMECs®)."
                    value={row.officialStatement ?? ""}
                    onChange={(e) =>
                      updateAccreditation(idx, {
                        officialStatement: e.target.value || undefined,
                      })
                    }
                  />
                </div>
              </div>
            ))}
          </div>

          <div className="flex items-center justify-between border-t pt-4">
            <div className="text-xs text-muted-foreground">
              {dirty
                ? "Unsaved changes."
                : settingsQuery.data
                  ? "All changes saved."
                  : "Loading…"}
            </div>
            <Button onClick={onSave} disabled={!dirty || saveMutation.isPending}>
              <Save className="h-4 w-4 mr-1" />
              Save
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ── Design approval (SUPER_ADMIN only) ─────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Lock className="h-4 w-4" />
            Design approval
          </CardTitle>
          <CardDescription>
            Once the CEO/MD has signed off the cert design after reviewing the
            preview below, flip this. The flag is required to enable the Issue
            button in Phase C. <strong>SUPER_ADMIN only.</strong>
          </CardDescription>
        </CardHeader>
        <CardContent>
          {editable?.designApprovedBy ? (
            <div className="flex items-center justify-between rounded-md border bg-green-50 p-3 text-sm dark:bg-green-950/40">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-green-600" />
                <span>
                  Approved on{" "}
                  <strong>
                    {new Date(editable.designApprovedAt!).toLocaleString()}
                  </strong>
                </span>
              </div>
              {isSuperAdmin && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => toggleApproval(false)}
                  disabled={saveMutation.isPending}
                >
                  Revoke approval
                </Button>
              )}
            </div>
          ) : (
            <div className="flex items-center justify-between rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:bg-amber-950/40">
              <div className="flex items-center gap-2">
                <Info className="h-4 w-4 text-amber-600" />
                <span>Design not yet approved — Issue button stays locked.</span>
              </div>
              {isSuperAdmin ? (
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="approve"
                    onCheckedChange={(c) => toggleApproval(c === true)}
                    disabled={saveMutation.isPending}
                  />
                  <Label htmlFor="approve" className="cursor-pointer">
                    Mark design approved
                  </Label>
                </div>
              ) : (
                <Badge variant="outline">SUPER_ADMIN only</Badge>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Preview ──────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Eye className="h-5 w-5" />
            Preview
          </CardTitle>
          <CardDescription>
            Renders a draft PDF using <strong>real event data</strong> + a
            synthetic recipient (&quot;Dr. Sample Attendee&quot;). No certificate
            is created, no email is sent, no audit row is written. Use these
            PDFs for the CEO/MD review.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid gap-2 min-w-[220px]">
              <Label>Certificate type</Label>
              <Select
                value={previewType}
                onValueChange={(v) => setPreviewType(v as CertType)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ATTENDANCE">Attendance</SelectItem>
                  <SelectItem value="PRESENTER">Presenter (Faculty)</SelectItem>
                  <SelectItem value="POSTER">Poster Presenter</SelectItem>
                  <SelectItem value="CME">CME</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button onClick={showPreview}>
              <Eye className="h-4 w-4 mr-1" />
              Generate preview
            </Button>
            {previewVisible && (
              <a
                href={previewSrc}
                download={`preview-${previewType.toLowerCase()}.pdf`}
                className="text-sm text-primary hover:underline"
              >
                Download PDF
              </a>
            )}
          </div>

          {previewVisible ? (
            <>
              {/* Probe-based status banner — replaces the silent "iframe blank
                  for unknown reason" failure mode with a visible explanation
                  when the server side is misbehaving. */}
              {previewProbe.kind === "probing" && (
                <div className="rounded-md border bg-muted px-3 py-2 text-xs text-muted-foreground">
                  Probing server response…
                </div>
              )}
              {previewProbe.kind === "ok" && (
                <div className="rounded-md border bg-green-50 px-3 py-2 text-xs text-green-700 dark:bg-green-950/30 dark:text-green-400">
                  Server returned {previewProbe.bytes.toLocaleString()} bytes of PDF.
                </div>
              )}
              {previewProbe.kind === "http-error" && (
                <div className="rounded-md border border-red-300 bg-red-50 px-3 py-3 text-xs text-red-700 dark:bg-red-950/30 dark:text-red-400">
                  <div className="font-semibold mb-1">
                    HTTP {previewProbe.status} from preview endpoint
                  </div>
                  <div>The PDF didn&apos;t render. Server response body:</div>
                  <pre className="mt-1 whitespace-pre-wrap break-all bg-red-100/50 p-2 rounded font-mono dark:bg-red-900/40">
                    {previewProbe.body.slice(0, 800)}
                  </pre>
                  <div className="mt-2">
                    Check{" "}
                    <code className="bg-red-100 dark:bg-red-900/40 px-1 rounded">
                      /logs?source=database&amp;search=cert-preview
                    </code>{" "}
                    for the server-side stack trace.
                  </div>
                </div>
              )}
              {previewProbe.kind === "network-error" && (
                <div className="rounded-md border border-red-300 bg-red-50 px-3 py-3 text-xs text-red-700 dark:bg-red-950/30 dark:text-red-400">
                  <div className="font-semibold mb-1">Network failure</div>
                  <div>{previewProbe.message}</div>
                  <div className="mt-2 text-muted-foreground">
                    The browser couldn&apos;t reach the preview endpoint at all.
                    Likely a deploy in progress, a server crash, or a network
                    interruption.
                  </div>
                </div>
              )}
              <div className="rounded-md border overflow-hidden bg-muted">
                <iframe
                  key={previewBust}
                  src={previewSrc}
                  className="w-full"
                  style={{ height: "700px" }}
                  title="Certificate preview"
                />
              </div>
            </>
          ) : (
            <div className="rounded-md border border-dashed p-12 text-center text-sm text-muted-foreground">
              Click <strong>Generate preview</strong> above to render a draft.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
