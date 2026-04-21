"use client";

import { useCallback, useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import { Node, Extension } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Image from "@tiptap/extension-image";
import TextAlign from "@tiptap/extension-text-align";
import Color from "@tiptap/extension-color";
import TextStyle from "@tiptap/extension-text-style";
import Underline from "@tiptap/extension-underline";
import Placeholder from "@tiptap/extension-placeholder";
import Table from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import { toast } from "sonner";

// ── Custom extensions for structural HTML preservation ──────────────────────

/**
 * DivBlock — preserves `<div>` elements with their `class` and `style`
 * attributes through ProseMirror's parse/serialize cycle. Without this,
 * ProseMirror strips divs entirely and converts their content to `<p>`.
 */
const DivBlock = Node.create({
  name: "divBlock",
  group: "block",
  content: "block+",
  defining: true,
  addAttributes() {
    return {
      class: {
        default: null,
        parseHTML: (el) => el.getAttribute("class"),
        renderHTML: (attrs) => (attrs.class ? { class: attrs.class } : {}),
      },
      style: {
        default: null,
        parseHTML: (el) => el.getAttribute("style"),
        renderHTML: (attrs) => (attrs.style ? { style: attrs.style } : {}),
      },
    };
  },
  parseHTML() {
    return [{ tag: "div" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", HTMLAttributes, 0];
  },
});

/**
 * StyleBlock — preserves `<style>` tags as atomic (non-editable) blocks.
 * The CSS text lives in a `css` attribute; rendered as `<style>{css}</style>`.
 * Useful for email templates that embed scoped CSS.
 */
const StyleBlock = Node.create({
  name: "styleBlock",
  group: "block",
  atom: true,
  addAttributes() {
    return {
      css: { default: "" },
    };
  },
  parseHTML() {
    return [
      {
        tag: "style",
        getAttrs: (el) => ({ css: (el as HTMLElement).textContent || "" }),
      },
    ];
  },
  renderHTML({ HTMLAttributes }) {
    return ["style", {}, HTMLAttributes.css || ""];
  },
});

/**
 * GlobalAttributes — adds `class` and `style` to every built-in node type
 * so ProseMirror preserves them on parse and emits them on serialize.
 * Without this, `<p style="color:red">` or `<h1 class="title">` lose
 * their attributes.
 */
const GlobalAttributes = Extension.create({
  name: "globalAttributes",
  addGlobalAttributes() {
    return [
      {
        types: [
          "paragraph",
          "heading",
          "blockquote",
          "bulletList",
          "orderedList",
          "listItem",
          "image",
          "hardBreak",
          "horizontalRule",
          "codeBlock",
          "table",
          "tableRow",
          "tableCell",
          "tableHeader",
        ],
        attributes: {
          class: {
            default: null,
            parseHTML: (el) => el.getAttribute("class") || null,
            renderHTML: (attrs) => (attrs.class ? { class: attrs.class } : {}),
          },
          style: {
            default: null,
            parseHTML: (el) => el.getAttribute("style") || null,
            renderHTML: (attrs) => (attrs.style ? { style: attrs.style } : {}),
          },
        },
      },
    ];
  },
});
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Bold,
  Italic,
  UnderlineIcon,
  Strikethrough,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  AlignLeft,
  AlignCenter,
  AlignRight,
  LinkIcon,
  ImageIcon,
  Undo,
  Redo,
  Code,
  Palette,
  Columns2,
  Square,
  Minus,
  ChevronDown,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface TiptapEditorProps {
  content: string;
  onChange: (html: string) => void;
  placeholder?: string;
}

function ToolbarButton({
  onClick,
  active = false,
  disabled = false,
  title,
  children,
}: {
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={`h-8 w-8 ${active ? "bg-muted text-foreground" : "text-muted-foreground"}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {children}
    </Button>
  );
}

function EditorToolbar({ editor }: { editor: ReturnType<typeof useEditor> }) {
  const addLink = useCallback(() => {
    if (!editor) return;
    const previousUrl = editor.getAttributes("link").href;
    const url = window.prompt("Enter URL:", previousUrl || "https://");
    if (url === null) return;
    if (url === "") {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
  }, [editor]);

  const addImage = useCallback(() => {
    if (!editor) return;
    const url = window.prompt("Enter image URL:");
    if (!url) return;
    editor.chain().focus().setImage({ src: url }).run();
  }, [editor]);

  if (!editor) return null;

  return (
    <div className="flex flex-wrap items-center gap-0.5 border-b p-1.5">
      {/* Text formatting */}
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleBold().run()}
        active={editor.isActive("bold")}
        title="Bold"
      >
        <Bold className="h-4 w-4" />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleItalic().run()}
        active={editor.isActive("italic")}
        title="Italic"
      >
        <Italic className="h-4 w-4" />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleUnderline().run()}
        active={editor.isActive("underline")}
        title="Underline"
      >
        <UnderlineIcon className="h-4 w-4" />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleStrike().run()}
        active={editor.isActive("strike")}
        title="Strikethrough"
      >
        <Strikethrough className="h-4 w-4" />
      </ToolbarButton>

      <div className="mx-1 h-6 w-px bg-border" />

      {/* Headings */}
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
        active={editor.isActive("heading", { level: 1 })}
        title="Heading 1"
      >
        <Heading1 className="h-4 w-4" />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        active={editor.isActive("heading", { level: 2 })}
        title="Heading 2"
      >
        <Heading2 className="h-4 w-4" />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
        active={editor.isActive("heading", { level: 3 })}
        title="Heading 3"
      >
        <Heading3 className="h-4 w-4" />
      </ToolbarButton>

      <div className="mx-1 h-6 w-px bg-border" />

      {/* Lists */}
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleBulletList().run()}
        active={editor.isActive("bulletList")}
        title="Bullet List"
      >
        <List className="h-4 w-4" />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
        active={editor.isActive("orderedList")}
        title="Ordered List"
      >
        <ListOrdered className="h-4 w-4" />
      </ToolbarButton>

      <div className="mx-1 h-6 w-px bg-border" />

      {/* Alignment */}
      <ToolbarButton
        onClick={() => editor.chain().focus().setTextAlign("left").run()}
        active={editor.isActive({ textAlign: "left" })}
        title="Align Left"
      >
        <AlignLeft className="h-4 w-4" />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().setTextAlign("center").run()}
        active={editor.isActive({ textAlign: "center" })}
        title="Align Center"
      >
        <AlignCenter className="h-4 w-4" />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().setTextAlign("right").run()}
        active={editor.isActive({ textAlign: "right" })}
        title="Align Right"
      >
        <AlignRight className="h-4 w-4" />
      </ToolbarButton>

      <div className="mx-1 h-6 w-px bg-border" />

      {/* Link & Image */}
      <ToolbarButton
        onClick={addLink}
        active={editor.isActive("link")}
        title="Insert Link"
      >
        <LinkIcon className="h-4 w-4" />
      </ToolbarButton>
      <ToolbarButton onClick={addImage} title="Insert Image">
        <ImageIcon className="h-4 w-4" />
      </ToolbarButton>

      <div className="mx-1 h-6 w-px bg-border" />

      {/* Color */}
      <div className="relative">
        <input
          type="color"
          className="absolute inset-0 h-8 w-8 cursor-pointer opacity-0"
          onChange={(e) => editor.chain().focus().setColor(e.target.value).run()}
          title="Text Color"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground pointer-events-none"
          tabIndex={-1}
        >
          <Palette className="h-4 w-4" />
        </Button>
      </div>

      <div className="mx-1 h-6 w-px bg-border" />

      {/* Layout blocks */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 px-2 text-muted-foreground text-xs gap-1"
            title="Insert layout block"
          >
            <Columns2 className="h-4 w-4" />
            Layout
            <ChevronDown className="h-3 w-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuItem onClick={() => {
            editor.chain().focus().insertContent(
              `<table style="width: 100%; border-collapse: collapse;" role="presentation"><tr><td style="width: 50%; padding: 10px; vertical-align: top;">Left column</td><td style="width: 50%; padding: 10px; vertical-align: top;">Right column</td></tr></table>`
            ).run();
          }}>
            <Columns2 className="mr-2 h-4 w-4" /> 2 Columns (50/50)
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => {
            editor.chain().focus().insertContent(
              `<table style="width: 100%; border-collapse: collapse;" role="presentation"><tr><td style="width: 33%; padding: 10px; vertical-align: top;">Col 1</td><td style="width: 34%; padding: 10px; vertical-align: top;">Col 2</td><td style="width: 33%; padding: 10px; vertical-align: top;">Col 3</td></tr></table>`
            ).run();
          }}>
            <Columns2 className="mr-2 h-4 w-4" /> 3 Columns (33/34/33)
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => {
            editor.chain().focus().insertContent(
              `<table style="width: 100%; border-collapse: collapse;" role="presentation"><tr><td style="width: 30%; padding: 10px; vertical-align: top;">Sidebar</td><td style="width: 70%; padding: 10px; vertical-align: top;">Main content</td></tr></table>`
            ).run();
          }}>
            <Columns2 className="mr-2 h-4 w-4" /> 2 Columns (30/70)
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => {
            editor.chain().focus().insertContent(
              `<div style="background-color: #f9fafb; padding: 20px; border-radius: 8px; border: 1px solid #e5e7eb;">Content box</div>`
            ).run();
          }}>
            <Square className="mr-2 h-4 w-4" /> Content Box (gray)
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => {
            editor.chain().focus().insertContent(
              `<div style="background-color: #eff6ff; padding: 20px; border-radius: 8px; border: 1px solid #bfdbfe;">Info box</div>`
            ).run();
          }}>
            <Square className="mr-2 h-4 w-4 text-blue-500" /> Info Box (blue)
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => {
            editor.chain().focus().insertContent(
              `<div style="background-color: #fef3c7; padding: 16px 20px; border-radius: 8px; border-left: 4px solid #f59e0b;">Highlight box</div>`
            ).run();
          }}>
            <Square className="mr-2 h-4 w-4 text-amber-500" /> Highlight Box (amber)
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => {
            editor.chain().focus().insertContent(
              `<div style="text-align: center; padding: 20px;"><a href="#" style="display: inline-block; background: #00aade; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 500;">Button Text</a></div>`
            ).run();
          }}>
            <Square className="mr-2 h-4 w-4 text-[#00aade]" /> CTA Button
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => {
            editor.chain().focus().insertContent(
              `<hr style="border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;">`
            ).run();
          }}>
            <Minus className="mr-2 h-4 w-4" /> Divider
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => {
            editor.chain().focus().insertContent(
              `<div style="height: 20px;"></div>`
            ).run();
          }}>
            <Minus className="mr-2 h-4 w-4 opacity-30" /> Spacer
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <div className="ml-auto flex items-center gap-0.5">
        {/* Undo/Redo */}
        <ToolbarButton
          onClick={() => editor.chain().focus().undo().run()}
          disabled={!editor.can().undo()}
          title="Undo"
        >
          <Undo className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().redo().run()}
          disabled={!editor.can().redo()}
          title="Redo"
        >
          <Redo className="h-4 w-4" />
        </ToolbarButton>
      </div>
    </div>
  );
}

/** Simple HTML formatter — adds line breaks and indentation for readability */
function formatHtml(html: string): string {
  let formatted = "";
  let indent = 0;
  // Split on tags while keeping the tags
  const tokens = html.replace(/>\s*</g, ">\n<").split("\n");
  for (const token of tokens) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    // Decrease indent for closing tags
    if (trimmed.startsWith("</")) indent = Math.max(0, indent - 1);
    formatted += "  ".repeat(indent) + trimmed + "\n";
    // Increase indent for opening tags (not self-closing, not void elements)
    if (
      trimmed.startsWith("<") &&
      !trimmed.startsWith("</") &&
      !trimmed.endsWith("/>") &&
      !/^<(br|hr|img|input|meta|link)\b/i.test(trimmed)
    ) {
      indent += 1;
    }
  }
  return formatted.trim();
}

export function TiptapEditor({ content, onChange, placeholder }: TiptapEditorProps) {
  const [sourceMode, setSourceMode] = useState(false);
  const [sourceHtml, setSourceHtml] = useState("");

  const editor = useEditor({
    extensions: [
      StarterKit,
      DivBlock,
      StyleBlock,
      GlobalAttributes,
      Underline,
      // Extend TextStyle (which handles <span>) to also preserve `class`.
      // Without this, <span class="highlight"> loses its class on parse.
      TextStyle.extend({
        addAttributes() {
          return {
            ...this.parent?.(),
            class: {
              default: null,
              parseHTML: (el) => el.getAttribute("class") || null,
              renderHTML: (attrs) => (attrs.class ? { class: attrs.class } : {}),
            },
          };
        },
      }),
      Color,
      Link.configure({ openOnClick: false, HTMLAttributes: { style: "color: #00aade; text-decoration: underline;" } }),
      Image.configure({ inline: true, allowBase64: true }),
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      Placeholder.configure({ placeholder: placeholder || "Start writing your email content..." }),
      Table.configure({ resizable: false, HTMLAttributes: { role: "presentation" } }),
      TableRow,
      TableHeader,
      TableCell,
    ],
    content,
    onUpdate: ({ editor: e }) => {
      onChange(e.getHTML());
    },
    editorProps: {
      attributes: {
        class: "prose prose-sm max-w-none focus:outline-none min-h-[300px] px-4 py-3 [&>*]:mb-4 [&>*:last-child]:mb-0",
      },
    },
  });

  const toggleSource = useCallback(() => {
    if (!editor) return;
    if (sourceMode) {
      // Switching from source to visual — warn about elements we still can't
      // represent (script, iframe, form). Divs, style tags, class/style attrs
      // are now handled by the custom extensions above.
      const hasUnsupported = /<(script|iframe|form|object|embed)\b/i.test(sourceHtml);
      if (hasUnsupported) {
        toast.info(
          "Some HTML elements (script, iframe, form) may be stripped in the visual editor. Use Source mode for full control.",
        );
      }
      editor.commands.setContent(sourceHtml);
      onChange(sourceHtml);
    } else {
      // Switching from visual to source — format for readability
      setSourceHtml(formatHtml(editor.getHTML()));
    }
    setSourceMode(!sourceMode);
  }, [editor, sourceMode, sourceHtml, onChange]);

  return (
    <div className="rounded-md border">
      <div className="flex items-center justify-between border-b px-2 py-1">
        {!sourceMode && <EditorToolbar editor={editor} />}
        {sourceMode && <span className="text-xs font-medium text-muted-foreground px-2">HTML Source</span>}
        <Button
          type="button"
          variant={sourceMode ? "secondary" : "ghost"}
          size="sm"
          onClick={toggleSource}
          className="ml-auto h-7 px-2 text-xs"
          title="Toggle HTML source"
        >
          <Code className="mr-1 h-3 w-3" />
          {sourceMode ? "Visual" : "Source"}
        </Button>
      </div>

      {sourceMode ? (
        <Textarea
          value={sourceHtml}
          onChange={(e) => setSourceHtml(e.target.value)}
          rows={20}
          className="border-0 rounded-none font-mono text-xs leading-relaxed focus-visible:ring-0 resize-y"
          placeholder="<!DOCTYPE html>..."
        />
      ) : (
        <EditorContent editor={editor} />
      )}
    </div>
  );
}
