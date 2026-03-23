"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { TagInput } from "@/components/ui/tag-input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";

type TagMode = "add" | "remove" | "replace";

const TAG_COLORS = [
  "bg-sky-50 text-sky-700 border-sky-200",
  "bg-emerald-50 text-emerald-700 border-emerald-200",
  "bg-violet-50 text-violet-700 border-violet-200",
  "bg-amber-50 text-amber-700 border-amber-200",
  "bg-rose-50 text-rose-700 border-rose-200",
  "bg-cyan-50 text-cyan-700 border-cyan-200",
];

function getTagColor(tag: string): string {
  let hash = 0;
  for (let i = 0; i < tag.length; i++) hash = (hash * 31 + tag.charCodeAt(i)) % TAG_COLORS.length;
  return TAG_COLORS[Math.abs(hash) % TAG_COLORS.length];
}

interface BulkTagDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedCount: number;
  entityLabel: string;
  existingTags?: string[];
  currentItemTags?: string[];
  isSingleItem?: boolean;
  isPending?: boolean;
  onSubmit: (tags: string[], mode: TagMode) => Promise<void>;
}

export function BulkTagDialog({
  open,
  onOpenChange,
  selectedCount,
  entityLabel,
  existingTags = [],
  currentItemTags,
  isSingleItem,
  isPending,
  onSubmit,
}: BulkTagDialogProps) {
  const [mode, setMode] = useState<TagMode>("add");
  const [tags, setTags] = useState<string[]>([]);

  const handleOpenChange = (isOpen: boolean) => {
    if (!isOpen) {
      setTags([]);
      setMode("add");
    }
    onOpenChange(isOpen);
  };

  const handleSubmit = async () => {
    if (tags.length === 0 && mode !== "replace") return;
    await onSubmit(tags, mode);
    handleOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base font-semibold">
            {isSingleItem
              ? "Manage Tags"
              : `Tag ${selectedCount} ${entityLabel}${selectedCount !== 1 ? "s" : ""}`}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-1">
          <div className="flex gap-1 p-1 bg-gray-100 rounded-lg">
            {(["add", "remove", "replace"] as TagMode[]).map((m) => (
              <button
                type="button"
                key={m}
                onClick={() => {
                  setMode(m);
                  if (m === "replace" && isSingleItem && currentItemTags) {
                    setTags([...currentItemTags]);
                  } else if (m !== "replace") {
                    setTags([]);
                  }
                }}
                className={`flex-1 text-xs font-medium py-1.5 rounded-md transition-all cursor-pointer ${
                  mode === m
                    ? "bg-white shadow-sm text-gray-800"
                    : "text-gray-500 hover:text-gray-700"
                }`}
              >
                {m === "add" ? "Add" : m === "remove" ? "Remove" : "Replace"}
              </button>
            ))}
          </div>

          {isSingleItem && currentItemTags && (
            currentItemTags.length > 0 ? (
              <div className="space-y-1.5">
                <p className="text-xs text-gray-400 font-medium">Current tags</p>
                <div className="flex flex-wrap gap-1">
                  {currentItemTags.map((tag) => (
                    <span key={tag} className={`text-xs px-2 py-0.5 rounded-full font-medium border ${getTagColor(tag)}`}>
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
            ) : (
              <p className="text-xs text-gray-400">No tags yet.</p>
            )
          )}

          <p className="text-xs text-gray-500 bg-gray-50 rounded-lg px-3 py-2">
            {mode === "add" && "New tags will be added. Existing tags are kept."}
            {mode === "remove" && "These tags will be removed. Other tags remain."}
            {mode === "replace" && "All existing tags will be replaced with these."}
          </p>

          {existingTags.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs text-gray-400 font-medium">Quick select from existing</p>
              <div className="flex flex-wrap gap-1">
                {existingTags.map((tag) => (
                  <button
                    type="button"
                    key={tag}
                    onClick={() => {
                      if (!tags.includes(tag)) {
                        setTags((v) => [...v, tag]);
                      }
                    }}
                    className={`text-xs px-2 py-0.5 rounded-full font-medium border cursor-pointer transition-opacity ${getTagColor(tag)} ${
                      tags.includes(tag) ? "opacity-30" : "hover:opacity-70"
                    }`}
                  >
                    {tag}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <Label className="text-xs text-gray-500 font-medium">
              {mode === "add" ? "Tags to add" : mode === "remove" ? "Tags to remove" : "Replace with"}
            </Label>
            <TagInput
              value={tags}
              onChange={setTags}
              placeholder="Type a tag and press Enter or comma"
            />
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => handleOpenChange(false)}>Cancel</Button>
          <Button
            className="btn-gradient"
            onClick={handleSubmit}
            disabled={isPending || (tags.length === 0 && mode !== "replace")}
          >
            {isPending ? "Saving..." : "Apply"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
