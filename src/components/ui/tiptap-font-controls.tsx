"use client";

/**
 * Font and size for an email's text (Nov 23, 2026; owner: every email, since
 * the sender and the editor are shared). Two parts, used together by the editor
 * when it is given `fontControls`:
 *
 *  - `FontStyle`: teaches the editor's text-style mark two more things to keep,
 *    `font-family` and `font-size`, written as inline styles (the only form a
 *    mail app honours). Without it the editor drops both on load.
 *  - `FontControls`: the two toolbar menus. A choice applies to the selected
 *    text, or to what is typed next.
 *
 * The lists and the rule for reading a font back are in src/lib/email-fonts.ts.
 */
import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  EMAIL_DEFAULT_FONT,
  EMAIL_DEFAULT_FONT_SIZE,
  EMAIL_FONTS,
  EMAIL_FONT_SIZES,
  emailFontFor,
  storedFontFamily,
  storedFontSize,
} from "@/lib/email-fonts";

export const FontStyle = Extension.create({
  name: "fontStyle",
  addGlobalAttributes() {
    return [
      {
        types: ["textStyle"],
        attributes: {
          fontFamily: {
            default: null,
            parseHTML: (el) => storedFontFamily(el.style.fontFamily),
            renderHTML: (attrs) => (attrs.fontFamily ? { style: `font-family: ${attrs.fontFamily}` } : {}),
          },
          fontSize: {
            default: null,
            parseHTML: (el) => storedFontSize(el.style.fontSize),
            renderHTML: (attrs) => (attrs.fontSize ? { style: `font-size: ${attrs.fontSize}` } : {}),
          },
        },
      },
    ];
  },
});

/** Set one text-style attribute on the selection; null clears it and drops a span left with nothing. */
function setTextStyle(editor: Editor, attrs: { fontFamily?: string | null; fontSize?: string | null }) {
  const chain = editor.chain().focus().setMark("textStyle", attrs);
  const clearing = Object.values(attrs).every((v) => v === null);
  (clearing ? chain.removeEmptyTextStyle() : chain).run();
}

const TRIGGER_CLASS = "h-8 gap-1 px-2 text-xs text-muted-foreground";

/** "14px" as the menu shows it: "14". */
const px = (size: string) => size.replace(/px$/, "");

/**
 * The line every email editor shows under its toolbar (owner, Nov 23, 2026:
 * "inform Open Sans as default and 14px font size default in note to people
 * using the system").
 */
export function FontDefaultsNote() {
  return (
    <p className="border-b bg-muted/30 px-3 py-1.5 text-[11px] leading-snug text-muted-foreground">
      Emails go out in <span className="font-medium text-foreground/80">{EMAIL_DEFAULT_FONT.label}</span>, size{" "}
      <span className="font-medium text-foreground/80">{px(EMAIL_DEFAULT_FONT_SIZE)}</span>, unless you choose another font or size for the
      selected text. Outlook and Gmail show Verdana in place of Montserrat, Inter and Open Sans.
    </p>
  );
}

export function FontControls({ editor }: { editor: Editor }) {
  const current = editor.getAttributes("textStyle") as { fontFamily?: string | null; fontSize?: string | null };
  // With nothing chosen the menus show what the email goes out in: the default.
  const chosenFont = emailFontFor(current.fontFamily);
  const font = chosenFont ?? (current.fontFamily ? null : EMAIL_DEFAULT_FONT);
  const fontLabel = font?.label ?? "Other";
  const sizeLabel = px(current.fontSize ?? EMAIL_DEFAULT_FONT_SIZE);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="sm" className={TRIGGER_CLASS} title="Font" aria-label={`Font: ${fontLabel}`}>
            <span className="max-w-[6rem] truncate" style={font ? { fontFamily: font.stack } : undefined}>
              {fontLabel}
            </span>
            <ChevronDown className="h-3 w-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          {EMAIL_FONTS.map((f) => (
            <DropdownMenuItem key={f.family} onClick={() => setTextStyle(editor, { fontFamily: f.stack })} style={{ fontFamily: f.stack }}>
              {f.label}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setTextStyle(editor, { fontFamily: null })}>Default ({EMAIL_DEFAULT_FONT.label})</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="sm" className={TRIGGER_CLASS} title="Text size" aria-label={`Text size: ${sizeLabel}`}>
            {sizeLabel}
            <ChevronDown className="h-3 w-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-32">
          {EMAIL_FONT_SIZES.map((s) => (
            <DropdownMenuItem key={s} onClick={() => setTextStyle(editor, { fontSize: s })}>
              {px(s)}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setTextStyle(editor, { fontSize: null })}>Default ({px(EMAIL_DEFAULT_FONT_SIZE)})</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
