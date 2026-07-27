/**
 * Shared Zod shape for a certificate text box + the standard-14 font list.
 *
 * Extracted when the starter-template route became the FOURTH consumer of this
 * shape: the templates collection POST and the `[templateId]` PATCH each
 * carried a byte-identical copy, and `agent/tools/certificates.ts` carries a
 * hand-rolled validator (deliberately — it returns JSON-RPC `{error, code}`
 * shapes rather than throwing, so it can't share a Zod schema). Adding a
 * fourth copy for the starter route is the thing the no-cross-caller-
 * duplication rule exists to prevent, so the three Zod consumers now share
 * one definition.
 *
 * The MCP validator stays separate but its font list is now imported from
 * here, so the twelve font names cannot drift between the REST and MCP doors.
 */

import { z } from "zod";

/** pdf-lib's twelve standard fonts — the complete set the renderer maps. */
export const CERTIFICATE_FONT_NAMES = [
  "Helvetica",
  "Helvetica-Bold",
  "Helvetica-Oblique",
  "Helvetica-BoldOblique",
  "Times-Roman",
  "Times-Bold",
  "Times-Italic",
  "Times-BoldItalic",
  "Courier",
  "Courier-Bold",
  "Courier-Oblique",
  "Courier-BoldOblique",
] as const;

/** Upper bound on boxes per template — shared by every write door. */
export const MAX_TEXT_BOXES_PER_TEMPLATE = 40;

export const certificateTextBoxSchema = z.object({
  id: z.string().min(1).max(64),
  content: z.string().max(500),
  x: z.number().min(0).max(20000),
  y: z.number().min(0).max(20000),
  width: z.number().min(1).max(20000),
  height: z.number().min(1).max(20000),
  font: z.enum(CERTIFICATE_FONT_NAMES),
  size: z.number().min(4).max(120),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "must be a 6-digit hex color"),
  align: z.enum(["left", "center", "right"]),
});

export const certificateTextBoxesSchema = z
  .array(certificateTextBoxSchema)
  .max(MAX_TEXT_BOXES_PER_TEMPLATE);
