"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import { Badge } from "./badge";
import { cn, normalizeTag } from "@/lib/utils";

interface TagInputProps {
  value: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
  /**
   * Optional list of existing tags shown as autocomplete suggestions
   * as the user types. Used to prevent accidental duplicates like
   * "VIP" vs "vip" vs "Vip" and to surface tags other team members
   * have already created. Pass an empty array (or omit) to disable
   * suggestions entirely — the input then behaves exactly like the
   * pre-suggestions version.
   *
   * The list does NOT need to be pre-deduped against `value`; the
   * component hides already-selected tags from the suggestion popover.
   */
  suggestions?: string[];
}

export function TagInput({
  value,
  onChange,
  placeholder = "Add tag...",
  disabled = false,
  suggestions,
}: TagInputProps) {
  const [input, setInput] = useState("");
  const [open, setOpen] = useState(false);
  // Highlighted suggestion index for keyboard nav (↑ ↓ + Enter). -1 =
  // nothing highlighted; Enter then adds the raw typed input instead
  // of a suggestion. Reset on every input change so navigation always
  // starts from the top.
  const [highlight, setHighlight] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const addTag = (raw: string) => {
    const tag = normalizeTag(raw);
    if (tag && !value.some((t) => normalizeTag(t) === tag)) {
      onChange([...value, tag]);
    }
    setInput("");
    setHighlight(-1);
  };

  const removeTag = (tag: string) => {
    onChange(value.filter((t) => t !== tag));
  };

  // Filter suggestions:
  //   1. drop tags already in `value` (case-insensitive via normalizeTag)
  //   2. on empty input, show the whole pool (capped at 8)
  //   3. on non-empty input, show case-insensitive substring matches
  //      with prefix matches first
  const filtered = useMemo(() => {
    if (!suggestions || suggestions.length === 0) return [];
    const selectedNormalized = new Set(value.map((t) => normalizeTag(t)));
    const q = input.trim().toLowerCase();

    const pool = suggestions.filter(
      (s) => !selectedNormalized.has(normalizeTag(s)),
    );
    if (q.length === 0) {
      return pool.slice(0, 8);
    }
    // Prefix matches sort first so "vip-2026" comes before "vip-old"
    // when typing "vip"; substring-only matches follow. Stable within
    // each bucket (preserves caller's sort, which is count-desc).
    const prefix: string[] = [];
    const substr: string[] = [];
    for (const s of pool) {
      const lower = s.toLowerCase();
      if (lower.startsWith(q)) prefix.push(s);
      else if (lower.includes(q)) substr.push(s);
    }
    return [...prefix, ...substr].slice(0, 8);
  }, [suggestions, value, input]);

  // Close dropdown on outside click — without this it stays open when
  // the user dismisses by clicking elsewhere in the form.
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener("mousedown", onDocClick);
      return () => document.removeEventListener("mousedown", onDocClick);
    }
  }, [open]);

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" && filtered.length > 0) {
      e.preventDefault();
      setOpen(true);
      setHighlight((h) => (h + 1) % filtered.length);
      return;
    }
    if (e.key === "ArrowUp" && filtered.length > 0) {
      e.preventDefault();
      setOpen(true);
      setHighlight((h) => (h <= 0 ? filtered.length - 1 : h - 1));
      return;
    }
    if (e.key === "Escape") {
      setOpen(false);
      setHighlight(-1);
      return;
    }
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      // If a suggestion is highlighted, prefer it over the raw input —
      // matches the user's intent when they navigated to it. Otherwise
      // commit the raw input (same as the pre-suggestion behavior).
      if (highlight >= 0 && filtered[highlight]) {
        addTag(filtered[highlight]);
      } else {
        addTag(input);
      }
      setOpen(false);
      return;
    }
    if (e.key === "Backspace" && input === "" && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  };

  const handleBlur = () => {
    // Defer so a click on a suggestion has a chance to fire its
    // onMouseDown before the input blurs and we commit the raw text.
    setTimeout(() => {
      if (input.trim()) addTag(input);
      setOpen(false);
    }, 100);
  };

  const showDropdown =
    open && !disabled && suggestions && filtered.length > 0;

  return (
    <div ref={wrapperRef} className="relative w-full">
      <div
        className="flex flex-wrap gap-1.5 min-h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 cursor-text"
        onClick={() => {
          inputRef.current?.focus();
          if (suggestions && suggestions.length > 0) setOpen(true);
        }}
      >
        {value.map((tag) => (
          <Badge key={tag} variant="secondary" className="gap-1 pr-1">
            {tag}
            {!disabled && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  removeTag(tag);
                }}
                className="ml-0.5 rounded-sm hover:bg-muted-foreground/20"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </Badge>
        ))}
        {!disabled && (
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setHighlight(-1);
              if (suggestions && suggestions.length > 0) setOpen(true);
            }}
            onFocus={() => {
              if (suggestions && suggestions.length > 0) setOpen(true);
            }}
            onKeyDown={handleKeyDown}
            onBlur={handleBlur}
            placeholder={value.length === 0 ? placeholder : ""}
            className="flex-1 min-w-20 outline-none bg-transparent placeholder:text-muted-foreground"
            // Browser autocomplete competes with our suggestion dropdown
            // when the user types into a name/email field above.
            autoComplete="off"
          />
        )}
      </div>

      {showDropdown ? (
        <div className="absolute z-50 mt-1 w-full max-w-md rounded-md border border-input bg-popover shadow-md">
          <div className="px-2 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground border-b">
            {input.trim().length > 0
              ? "Matching tags"
              : "Existing tags"}
          </div>
          <ul className="max-h-56 overflow-y-auto py-1">
            {filtered.map((s, i) => (
              <li key={s}>
                <button
                  type="button"
                  // onMouseDown (not onClick) so the click registers
                  // before the input's onBlur fires (which would commit
                  // the raw typed text). 100ms blur defer above is the
                  // belt; this is the suspenders.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    addTag(s);
                    setOpen(false);
                  }}
                  onMouseEnter={() => setHighlight(i)}
                  className={cn(
                    "w-full text-left px-3 py-1.5 text-sm flex items-center justify-between gap-2 hover:bg-accent hover:text-accent-foreground",
                    i === highlight && "bg-accent text-accent-foreground",
                  )}
                >
                  <span className="truncate">{s}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
