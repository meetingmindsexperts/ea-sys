"use client";

/**
 * "Select by IDs" for abstracts: paste abstract numbers and have those rows
 * ticked, so the bulk reviewer actions run on exactly them. The same workflow
 * as Registrations and Certificates; the numbers are read loosely ("012", "12"
 * and "A-012" are all A-012) by src/lib/abstract-reviewer-sheet.ts.
 */
import { useState } from "react";
import { ListChecks } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { resolvePastedAbstractIds, type SheetAbstract } from "@/lib/abstract-reviewer-sheet";

type MatchResult = { matched: string[]; unmatched: string[] };

function ByIdsBody({
  abstracts,
  onSelect,
  onCancel,
}: {
  abstracts: SheetAbstract[];
  onSelect: (result: MatchResult) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState("");
  const [result, setResult] = useState<MatchResult | null>(null);

  const match = () => resolvePastedAbstractIds(text, abstracts);

  return (
    <>
      <div className="space-y-3 py-1">
        <div className="space-y-2">
          <Label htmlFor="paste-abstract-ids">Abstract numbers</Label>
          <Textarea
            id="paste-abstract-ids"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setResult(null);
            }}
            placeholder={"012\n15\nA-040"}
            rows={7}
            // The shared Textarea grows with its content, so cap it and scroll inside.
            className="max-h-60 overflow-y-auto font-mono text-sm"
          />
          <p className="text-xs text-muted-foreground">
            One per line, or separated by commas or spaces. 012, 12 and A-012 all mean A-012.
          </p>
        </div>
        {result && (
          <div className="rounded-md border bg-muted/40 p-3 text-sm">
            <p className="font-medium">
              {result.matched.length} matched
              {result.unmatched.length > 0 && `, ${result.unmatched.length} not found`}
            </p>
            {result.unmatched.length > 0 && (
              <p className="mt-1 break-words text-xs text-muted-foreground">
                Not found: {result.unmatched.slice(0, 30).join(", ")}
                {result.unmatched.length > 30 ? ` and ${result.unmatched.length - 30} more` : ""}
              </p>
            )}
          </div>
        )}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="secondary" onClick={() => setResult(match())} disabled={!text.trim()}>
          Match
        </Button>
        <Button onClick={() => onSelect(result ?? match())} disabled={!text.trim()}>
          Select{result ? ` ${result.matched.length}` : ""}
        </Button>
      </DialogFooter>
    </>
  );
}

export function SelectAbstractsByIdsDialog({
  abstracts,
  open,
  onOpenChange,
  onSelect,
}: {
  abstracts: SheetAbstract[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with what the pasted text matched; the page ticks those rows. */
  onSelect: (result: MatchResult) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ListChecks className="h-5 w-5" />
            Select by IDs
          </DialogTitle>
          <DialogDescription>
            Paste abstract numbers. The matching abstracts become the selection, across every theme and filter, so
            you can assign or remove a reviewer for exactly those. Anything ticked before is unticked.
          </DialogDescription>
        </DialogHeader>
        {/* Mounted only while open, so each opening starts empty. */}
        {open && <ByIdsBody abstracts={abstracts} onSelect={onSelect} onCancel={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}
