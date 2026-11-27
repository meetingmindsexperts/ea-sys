"use client";

/**
 * The Badge card's barcode width control (Nov 27, 2026): a slider and an exact
 * number over one value, with a small picture of the barcode in the row it may
 * fill, so the organiser sees the size without opening the preview. An empty
 * value means the barcode fills its row, as badges have always printed.
 */
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** The smallest width the layout accepts (MIN_BARCODE_W_PT in badge-layout.ts, about 20mm). */
const MIN_MM = 20;

const BARS =
  "repeating-linear-gradient(90deg, #111 0 2px, transparent 2px 3px, #111 3px 4px, transparent 4px 7px, #111 7px 10px, transparent 10px 12px)";

export function BadgeBarcodeWidth({
  valueMm,
  fullWidthMm,
  onChange,
}: {
  /** As typed; "" = fill the row. */
  valueMm: string;
  /** The width of the barcode's row on this badge. */
  fullWidthMm: number;
  onChange: (valueMm: string) => void;
}) {
  const full = Math.max(MIN_MM, Math.floor(fullWidthMm));
  const typed = Number(valueMm);
  // A width at or past the row changes nothing, so it reads as full width.
  const narrowed = typed > 0 && typed < full;
  const shown = narrowed ? Math.max(MIN_MM, typed) : full;
  const share = shown / full;

  return (
    <div className="space-y-3">
      <div className="flex max-w-md items-baseline justify-between gap-3">
        <Label htmlFor="badgeBarcodeWidthMm">Barcode width</Label>
        <span className="text-sm tabular-nums text-muted-foreground">
          {narrowed ? `${shown} of ${full} mm` : `Full width, ${full} mm`}
        </span>
      </div>
      {/* The row the barcode may fill, with the barcode at the chosen size. */}
      <div
        aria-hidden
        className="flex h-14 max-w-md items-center justify-center rounded-md border border-dashed bg-white"
      >
        <div style={{ width: `${share * 100}%`, height: `${share * 72}%`, backgroundImage: BARS }} />
      </div>
      <input
        type="range"
        aria-label="Barcode width in millimetres"
        min={MIN_MM}
        max={full}
        step={1}
        value={shown}
        onChange={(e) => onChange(Number(e.target.value) >= full ? "" : e.target.value)}
        className="block w-full max-w-md accent-primary"
      />
      <div className="flex items-center gap-2">
        <Input
          id="badgeBarcodeWidthMm"
          type="number"
          min={MIN_MM}
          max={full}
          step="1"
          placeholder={String(full)}
          value={valueMm}
          onChange={(e) => onChange(e.target.value)}
          className="w-24"
        />
        <span className="text-sm text-muted-foreground">mm</span>
        {valueMm !== "" && (
          <Button type="button" variant="ghost" size="sm" onClick={() => onChange("")}>
            Use full width
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Drag, or type an exact width. The barcode stays centred and its height shrinks with it. Full
        width is how badges have always printed.
      </p>
    </div>
  );
}
