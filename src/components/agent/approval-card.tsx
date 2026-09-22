"use client";

// The pause the loop asks for: what the agent wants to do, in plain words,
// with Approve and Cancel. Approve sends the call back with the token the
// loop minted for it; the route verifies the token names exactly this call
// for this person before anything runs (architecture review §4.5).

import { useState } from "react";
import { AlertTriangle, Check, ShieldCheck, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { approvalRows } from "@/lib/agent/approval-display";

export interface ApprovalMessage {
  toolName: string;
  label: string;
  input: Record<string, unknown>;
  token: string;
  expiresAt: string;
  status: "pending" | "approved" | "cancelled";
}

export function ApprovalCard({
  approval,
  disabled,
  onApprove,
  onCancel,
}: {
  approval: ApprovalMessage;
  disabled: boolean;
  onApprove: () => void;
  onCancel: () => void;
}) {
  // Captured once per mount: the card does not need a live clock, and
  // reading the clock during render is impure (react-hooks/purity).
  const [now] = useState(() => Date.now());
  const expired = approval.status === "pending" && new Date(approval.expiresAt).getTime() <= now;
  // Every field of the call, arrays of objects opened one row per item, so
  // the person approves what they can read (src/lib/agent/approval-display.ts).
  const rows = approvalRows(approval.input);

  return (
    <div className="flex justify-start mb-3">
      <div
        className={cn(
          "w-full max-w-[85%] rounded-xl border px-4 py-3 text-sm shadow-sm",
          approval.status === "pending" && !expired && "border-primary/40 bg-primary/5",
          approval.status === "approved" && "border-green-200 bg-green-50",
          (approval.status === "cancelled" || expired) && "border-border bg-muted/40 text-muted-foreground",
        )}
      >
        <div className="flex items-center gap-2 font-medium">
          <ShieldCheck className="h-4 w-4 text-primary" />
          <span>{approval.label}</span>
          <span className="ml-auto text-xs font-normal text-muted-foreground">
            {approval.status === "approved" && "Approved"}
            {approval.status === "cancelled" && "Cancelled"}
            {approval.status === "pending" && (expired ? "Expired" : "Needs your approval")}
          </span>
        </div>
        {rows.length > 0 && (
          <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
            {rows.map((row) => (
              <div key={row.label} className="contents">
                <dt className="text-muted-foreground">{row.label}</dt>
                <dd className="break-words">
                  {row.items ? (
                    <ol className="space-y-0.5" data-testid="approval-items">
                      {row.items.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ol>
                  ) : (
                    row.text
                  )}
                </dd>
              </div>
            ))}
          </dl>
        )}
        {approval.status === "pending" && !expired && (
          <div className="mt-3 flex items-center gap-2">
            <Button size="sm" onClick={onApprove} disabled={disabled}>
              <Check className="h-4 w-4 mr-1" /> Approve
            </Button>
            <Button size="sm" variant="outline" onClick={onCancel} disabled={disabled}>
              <X className="h-4 w-4 mr-1" /> Cancel
            </Button>
            <span className="text-xs text-muted-foreground">Nothing runs until you approve.</span>
          </div>
        )}
        {expired && (
          <p className="mt-2 flex items-center gap-1 text-xs">
            <AlertTriangle className="h-3.5 w-3.5" /> This approval expired. Ask again to get a fresh one.
          </p>
        )}
      </div>
    </div>
  );
}
