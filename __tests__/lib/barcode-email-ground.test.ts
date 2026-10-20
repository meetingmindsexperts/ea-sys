/**
 * The email barcode image carries its own white ground (Oct 20, 2026). PR #38
 * removed the white bordered box around it, and bwip-js draws on a TRANSPARENT
 * ground by default, so a dark-mode mail client would put black bars on a dark
 * background. Renders for real (no mock) and reads the PNG header.
 */
import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { renderBarcodePng } from "@/lib/barcode";

const VALUE = "1787726079218992629-011";

/** Width, and whether any pixel is see-through (alpha below 255). */
async function inspect(png: Buffer) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let transparent = false;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 255) { transparent = true; break; }
  return { width: info.width, transparent, topLeft: [...data.subarray(0, 4)] };
}

describe("renderBarcodePng quiet zone", () => {
  it("is opaque, with the quiet zone on both sides, when asked", async () => {
    const plain = await inspect(await renderBarcodePng(VALUE, { includetext: true }));
    const email = await inspect(await renderBarcodePng(VALUE, { includetext: true, quietZone: 10 }));
    expect(email.transparent).toBe(false);
    expect(email.topLeft).toEqual([255, 255, 255, 255]);
    // 10 modules each side at the default scale of 2.
    expect(email.width).toBe(plain.width + 2 * 10 * 2);
  });

  it("leaves the badge and download renders as they were", async () => {
    expect((await inspect(await renderBarcodePng(VALUE))).transparent).toBe(true);
    expect((await inspect(await renderBarcodePng(VALUE, { includetext: true }))).transparent).toBe(true);
  });
});
