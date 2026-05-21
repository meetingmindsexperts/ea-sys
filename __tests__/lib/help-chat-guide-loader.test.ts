/**
 * Tests for `stripHtml` — the HTML→text pass that produces the help
 * chat's KB content. Pins behavior that matters for two reasons:
 *
 *   1. **Safety** — script/style/comment bodies must not leak into
 *      the system prompt (prompt-injection surface + token bloat).
 *   2. **Correctness** — entity decoding + the space-replace tag
 *      strip preserve text the model needs to read.
 *
 * Not tested (deliberately):
 *   - `getGuideContent()` caching behavior — trivial.
 *   - `fs.readFileSync` error path — trivial wrapper.
 */

import { describe, it, expect } from "vitest";
import { stripHtml } from "@/lib/help-chat/guide-loader";

describe("stripHtml — safety: bodies that must not leak", () => {
  it("removes <script> bodies entirely (token bloat + prompt-injection surface)", () => {
    const out = stripHtml(
      "<p>hello</p><script>alert('pwned');const x = 'secret';</script><p>world</p>",
    );
    expect(out).toContain("hello");
    expect(out).toContain("world");
    expect(out).not.toContain("alert");
    expect(out).not.toContain("secret");
  });

  it("removes <script src=...> tags with attributes too", () => {
    const out = stripHtml(
      `<script src="x.js" defer>console.log('boom');</script>visible`,
    );
    expect(out).not.toContain("console");
    expect(out).not.toContain("boom");
    expect(out).toContain("visible");
  });

  it("removes <style> bodies entirely", () => {
    const out = stripHtml(
      "<p>hello</p><style>body { color: red; --foo: 'leak'; }</style>world",
    );
    expect(out).toContain("hello");
    expect(out).toContain("world");
    expect(out).not.toContain("color: red");
    expect(out).not.toContain("leak");
  });

  it("removes HTML comments", () => {
    const out = stripHtml("before<!-- TODO: remove this internal note -->after");
    expect(out).toContain("before");
    expect(out).toContain("after");
    expect(out).not.toContain("TODO");
    expect(out).not.toContain("internal note");
  });

  it("removes multi-line HTML comments (the longest-leaking case)", () => {
    const out = stripHtml(`a<!--
      multi-line
      comment with
      internal notes
    -->b`);
    expect(out).not.toContain("multi-line");
    expect(out).not.toContain("internal notes");
    expect(out).toContain("a");
    expect(out).toContain("b");
  });
});

describe("stripHtml — entity decoding", () => {
  it("decodes the common named entities the guide contains", () => {
    const out = stripHtml(
      "Q&amp;A &mdash; uses &ldquo;curly&rdquo; quotes&hellip;",
    );
    expect(out).toBe("Q&A — uses “curly” quotes…");
  });

  it("decodes &nbsp; to a regular space (and collapses run)", () => {
    const out = stripHtml("hello&nbsp;&nbsp;world");
    expect(out).toBe("hello world");
  });

  it("decodes decimal numeric entities (e.g. &#39;)", () => {
    const out = stripHtml("it&#39;s here");
    expect(out).toBe("it's here");
  });

  it("decodes hex numeric entities (e.g. &#x2014; em-dash)", () => {
    const out = stripHtml("a &#x2014; b");
    expect(out).toBe("a — b");
  });

  it("leaves unknown entities verbatim (no silent corruption)", () => {
    // If the guide ever uses some obscure entity we didn't whitelist,
    // we'd rather see the literal "&unknownentity;" in the prompt than
    // silently drop it or convert to something wrong.
    const out = stripHtml("known &amp; and unknown &nonexistent; here");
    expect(out).toContain("&");
    expect(out).toContain("&nonexistent;");
  });
});

describe("stripHtml — tag stripping + whitespace", () => {
  it("preserves word boundaries between adjacent inline tags", () => {
    // The space-replace rule (not empty-replace) is what makes this work.
    expect(stripHtml("<b>foo</b><i>bar</i>")).toBe("foo bar");
    expect(stripHtml("<span>a</span><span>b</span><span>c</span>")).toBe("a b c");
  });

  it("collapses whitespace runs to single spaces and trims", () => {
    expect(stripHtml("  <p>a</p>   <p>b</p>  ")).toBe("a b");
    expect(stripHtml("a\n\n\nb\t\tc")).toBe("a b c");
  });

  it("strips self-closing + attribute-laden tags", () => {
    expect(stripHtml(`<img src="x" alt="y"/>hello<br/>world`)).toBe("hello world");
  });

  it("handles malformed HTML without crashing (regex is permissive)", () => {
    // Real-world guides occasionally have malformed snippets. Don't
    // throw — just produce something readable.
    const out = stripHtml("<p>open <b>not closed text");
    expect(out).toContain("open");
    expect(out).toContain("not closed text");
  });
});
