/**
 * MCP TOOL INVENTORY, does the reference describe the server we actually ship?
 *
 * The MCP surface is the one part of EA-SYS whose users cannot read the source.
 * n8n workflows, claude.ai connectors and Claude Desktop are built against
 * `docs/MCP_REFERENCE.md`, so a wrong tool list there is not untidiness, it is
 * an integrator building against a tool that does not exist or never learning
 * about one that does.
 *
 * It had drifted by FORTY-THREE tools when this file was written: the doc said
 * 70, the server registered 113 (87 core plus 26 CRM). It also disagreed with
 * itself, "71 tools" in the header against "Tools (70 total)" in the section
 * title. Nothing anywhere pinned the number, so nothing went red.
 *
 * WHY IT COUNTS BY REGISTERING RATHER THAN BY GREPPING. The obvious
 * implementation scans the source for something shaped like a registration,
 * which answers a question nobody asked: how many things LOOK like tools. This
 * calls the real `registerAllMcpTools` against a stub server that records what
 * it is handed, so a tool defined and never registered is absent here exactly
 * as it is absent from the running server, and the CRM tools registered from
 * inside their own module are counted without this file having to know they
 * exist.
 *
 * The removal direction matters more than the addition one, and is easy to
 * forget: a documented tool that no longer exists sends an integrator to write
 * a call that will 404 forever.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

vi.mock("@/lib/db", () => ({ db: {}, dbOperator: {} }));

const DOC = path.join(process.cwd(), "docs", "MCP_REFERENCE.md");

/** Everything `registerAllMcpTools` hands to a server, without needing one. */
async function registeredToolNames(): Promise<string[]> {
  const names: string[] = [];
  const stub = {
    tool: (name: string) => void names.push(name),
    resource: () => {},
    prompt: () => {},
  };
  const { registerAllMcpTools } = await import("@/lib/agent/register-mcp-tools");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerAllMcpTools(stub as any, "org_test");
  return names;
}

interface DocTools {
  /** The N in `## Tools (N total)`. */
  declaredTotal: number | null;
  /** Every `| \`tool_name\` |` row in the reference. */
  listed: string[];
  /** Each `### Heading (N)` against the rows that follow it. */
  sections: { heading: string; declared: number; actual: number }[];
}

/**
 * Headings inside the tools block that carry prose rather than a tool table,
 * and therefore no `(N)`. Named explicitly: the first version of this parser
 * silently skipped any heading it could not read a number from, which meant a
 * heading that LOST its count was ignored rather than reported, and it silently
 * folded three Webinar rows into Accommodation's total because that heading read
 * `(3, WEBINAR-type events only)`. A parser that shrugs at what it cannot parse
 * is how a gate goes quiet.
 */
const PROSE_HEADINGS = ["Not on MCP"];

function parseDoc(): DocTools {
  const md = readFileSync(DOC, "utf8");
  const declared = md.match(/^## Tools \((\d+) total\)/m);
  // Scope to the tools block: `### Per-tool buckets` under Rate Limits is not a
  // tool section, and counting its rows would be nonsense.
  const from = md.indexOf("## Tools (");
  const to = md.indexOf("## Resources (");
  const block = from >= 0 && to > from ? md.slice(from, to) : "";
  const listed = [...block.matchAll(/^\|\s*`([a-z_]+)`\s*\|/gm)].map((m) => m[1]);

  const sections: DocTools["sections"] = [];
  let current: { heading: string; declared: number; actual: number } | null = null;
  for (const line of block.split("\n")) {
    if (/^### /.test(line)) {
      if (current) sections.push(current);
      current = null;
      const h = line.match(/^### (.+?) \((\d+)\)\s*$/);
      if (h) {
        current = { heading: h[1], declared: Number(h[2]), actual: 0 };
      } else if (!PROSE_HEADINGS.some((p) => line.includes(p))) {
        // Reported through the section test rather than thrown, so the failure
        // names the heading instead of a stack trace.
        sections.push({ heading: line.replace(/^### /, "") + " (no count)", declared: -1, actual: 0 });
      }
      continue;
    }
    if (current && /^\|\s*`[a-z_]+`\s*\|/.test(line)) current.actual += 1;
  }
  if (current) sections.push(current);

  return { declaredTotal: declared ? Number(declared[1]) : null, listed, sections };
}

describe("MCP tool inventory", () => {
  it("registers a plausible number of tools", async () => {
    // A stub that silently recorded nothing would make every assertion below
    // vacuous. Pin the floor first.
    const names = await registeredToolNames();
    expect(names.length).toBeGreaterThan(50);
    expect(new Set(names).size, "a tool name is registered twice").toBe(names.length);
  });

  it("states the real total in docs/MCP_REFERENCE.md", async () => {
    const names = await registeredToolNames();
    const { declaredTotal } = parseDoc();
    expect(
      declaredTotal,
      `docs/MCP_REFERENCE.md must carry a "## Tools (N total)" heading`,
    ).not.toBeNull();
    expect(
      declaredTotal,
      "The reference's tool count is stale. Update the '## Tools (N total)' heading " +
        "AND the count in the header line near the top of the file.",
    ).toBe(names.length);
  });

  it("documents every tool the server registers", async () => {
    const names = await registeredToolNames();
    const { listed } = parseDoc();
    const undocumented = names.filter((n) => !listed.includes(n)).sort();
    expect(
      undocumented,
      "These tools are registered but absent from docs/MCP_REFERENCE.md. An " +
        "integrator cannot read the source, so an undocumented tool does not exist.",
    ).toEqual([]);
  });

  it("does not document a tool the server no longer registers", async () => {
    // The dangerous direction. An addition is a missed opportunity; a stale
    // entry sends someone to build a call that will never resolve.
    const names = new Set(await registeredToolNames());
    const { listed } = parseDoc();
    const phantom = [...new Set(listed.filter((n) => !names.has(n)))].sort();
    expect(
      phantom,
      "docs/MCP_REFERENCE.md documents tools that are not registered.",
    ).toEqual([]);
  });

  it("keeps each section's own count honest", () => {
    // Cheap, and it caught real drift on the first run: "Organization-level (3)"
    // sat above four rows.
    const wrong = parseDoc()
      .sections.filter((s) => s.declared !== s.actual)
      .map((s) => `${s.heading}: says ${s.declared}, lists ${s.actual}`);
    expect(wrong, "section headings disagree with the rows beneath them").toEqual([]);
  });
});
