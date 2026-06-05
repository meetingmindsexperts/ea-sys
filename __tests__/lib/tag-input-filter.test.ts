/**
 * Unit tests for filterTagSuggestions — the pure filter behind the
 * TagInput autocomplete dropdown. The function was extracted from
 * the component so the rules (case-insensitive dedup vs selected,
 * prefix-before-substring, cap-at-N) can be exercised exhaustively
 * without spinning up jsdom for the React tree.
 *
 * If this contract regresses, operators stop seeing existing tags
 * as suggestions (or worse, see ones they've already selected),
 * which silently reintroduces the duplicate-tag problem this
 * feature shipped to fix.
 */

import { describe, it, expect } from "vitest";
import { filterTagSuggestions } from "@/components/ui/tag-input";

describe("filterTagSuggestions", () => {
  // ── Empty / pool guards ──────────────────────────────────────────────

  it("returns [] when suggestions is undefined", () => {
    expect(filterTagSuggestions(undefined, [], "anything")).toEqual([]);
  });

  it("returns [] when suggestions is empty", () => {
    expect(filterTagSuggestions([], [], "anything")).toEqual([]);
  });

  // ── Empty input → return the whole pool capped ────────────────────────

  it("returns the whole pool capped at 8 when input is empty", () => {
    const pool = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
    expect(filterTagSuggestions(pool, [], "")).toEqual([
      "a", "b", "c", "d", "e", "f", "g", "h",
    ]);
  });

  it("returns the whole pool when smaller than the cap", () => {
    expect(filterTagSuggestions(["a", "b", "c"], [], "")).toEqual([
      "a", "b", "c",
    ]);
  });

  it("treats whitespace-only input as empty (no filter, full pool)", () => {
    expect(filterTagSuggestions(["vip", "speaker"], [], "   ")).toEqual([
      "vip",
      "speaker",
    ]);
  });

  // ── Case-insensitive dedup vs selected ───────────────────────────────

  it("hides selected tags case-insensitively", () => {
    // Selected "VIP" should hide all of "vip", "VIP", "Vip" from
    // suggestions — the whole reason this feature ships.
    expect(
      filterTagSuggestions(
        ["VIP", "vip", "Vip", "speaker"],
        ["VIP"],
        "",
      ),
    ).toEqual(["speaker"]);
  });

  it("dedupes against multiple selected tags", () => {
    expect(
      filterTagSuggestions(
        ["VIP", "speaker", "checked-in", "PANELIST"],
        ["vip", "PANELIST"],
        "",
      ),
    ).toEqual(["speaker", "checked-in"]);
  });

  // ── Prefix matches sort before substring matches ─────────────────────

  it("prefix matches come before substring matches", () => {
    expect(
      filterTagSuggestions(
        ["chair-vip", "vip-2026", "vip-old", "speaker"],
        [],
        "vip",
      ),
    ).toEqual(["vip-2026", "vip-old", "chair-vip"]);
  });

  it("preserves caller order within each bucket (caller sorts by count)", () => {
    // Caller passes suggestions count-desc; both 'vip-a' and 'vip-b'
    // are prefix matches, so they appear in input order — NOT
    // alphabetized — which means the more-popular one shows first.
    expect(
      filterTagSuggestions(["vip-b", "vip-a"], [], "vip"),
    ).toEqual(["vip-b", "vip-a"]);
  });

  it("is case-insensitive on the input query", () => {
    expect(
      filterTagSuggestions(["VIP-2026", "speaker"], [], "vip"),
    ).toEqual(["VIP-2026"]);
  });

  it("is case-insensitive on the suggestion text", () => {
    expect(
      filterTagSuggestions(["VIP", "vip-2026"], [], "VIP"),
    ).toEqual(["VIP", "vip-2026"]);
  });

  it("trims the input before matching", () => {
    expect(
      filterTagSuggestions(["vip", "speaker"], [], "  vip  "),
    ).toEqual(["vip"]);
  });

  // ── No matches ───────────────────────────────────────────────────────

  it("returns [] when the input matches nothing", () => {
    expect(
      filterTagSuggestions(["vip", "speaker"], [], "doctor"),
    ).toEqual([]);
  });

  // ── Cap (default + custom) ───────────────────────────────────────────

  it("caps combined prefix+substring matches at 8 by default", () => {
    // 10 prefix matches; only the first 8 should make it out.
    const pool = Array.from({ length: 10 }, (_, i) => `vip-${i}`);
    expect(filterTagSuggestions(pool, [], "vip")).toEqual(pool.slice(0, 8));
  });

  it("respects a custom cap", () => {
    expect(
      filterTagSuggestions(["a", "b", "c", "d", "e"], [], "", 3),
    ).toEqual(["a", "b", "c"]);
  });

  // ── Combined rules ───────────────────────────────────────────────────

  it("applies dedup AND prefix-before-substring AND cap together", () => {
    // Pool has selected items, prefix matches, substring matches,
    // and overflow. Expected output: prefix first, then substring,
    // selected hidden, capped at 4.
    expect(
      filterTagSuggestions(
        // selected ↓
        ["VIP", "vip-2026", "chair-vip", "vip-old", "speaker-vip", "checked-in"],
        ["vip"], // case-insensitive hides "VIP"
        "vip",
        4,
      ),
    ).toEqual(["vip-2026", "vip-old", "chair-vip", "speaker-vip"]);
  });
});
