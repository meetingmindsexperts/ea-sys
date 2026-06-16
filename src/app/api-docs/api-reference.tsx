"use client";

import { useState } from "react";

/**
 * Self-hosted API reference renderer for the EA-SYS OpenAPI 3.1 spec.
 *
 * Replaces the @scalar/api-reference-react widget (heavy browser-only Vue
 * bundle that wouldn't render in prod and was the INC-001 build-weight
 * trigger). This reads the spec object the server already built and renders
 * plain React — no external runtime, no CDN, server-rendered HTML.
 *
 * It is NOT a general OpenAPI engine — it renders *our* spec (a small,
 * read-focused, API-key surface). The shapes it handles: tags, GET/POST
 * operations, query/path params, JSON request bodies, JSON responses, and
 * $ref'd component schemas (objects, arrays, enums, nullable scalars).
 */

type JsonObj = Record<string, unknown>;

const asObj = (v: unknown): JsonObj => (v && typeof v === "object" && !Array.isArray(v) ? (v as JsonObj) : {});
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const asStr = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

const METHODS = ["get", "post", "put", "patch", "delete"] as const;

const METHOD_STYLE: Record<string, string> = {
  get: "text-[#0a7d4d] bg-[#e7f4ec] border-[#bfe3cd]",
  post: "text-[#9a5b00] bg-[#fbf0dd] border-[#eccfa0]",
  put: "text-[#1f5fa8] bg-[#e6effa] border-[#bcd2f0]",
  patch: "text-[#1f5fa8] bg-[#e6eeff] border-[#bcd2f0]",
  delete: "text-[#a3232c] bg-[#fce8e8] border-[#f0c0c0]",
};

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const opId = (method: string, path: string) => `op-${method}-${slug(path)}`;

function resolveRef(ref: string, spec: JsonObj): JsonObj {
  const parts = ref.replace(/^#\//, "").split("/");
  let cur: unknown = spec;
  for (const p of parts) cur = asObj(cur)[p];
  return asObj(cur);
}

/** Short type label, e.g. "string", "string<date-time>", "Event[]", "integer". */
function typeLabel(schema: JsonObj, spec: JsonObj): string {
  const ref = asStr(schema["$ref"]);
  if (ref) return ref.split("/").pop() ?? "object";
  const t = asStr(schema.type);
  if (t === "array") return `${typeLabel(asObj(schema.items), spec)}[]`;
  const fmt = asStr(schema.format);
  if (t === "string" && fmt) return `string<${fmt}>`;
  if (t) return t;
  if (schema.properties) return "object";
  return "any";
}

/** Build a minimal JSON example object from a schema's required fields. */
function sampleBody(schema: JsonObj, spec: JsonObj): Record<string, unknown> {
  const ref = asStr(schema["$ref"]);
  const s = ref ? resolveRef(ref, spec) : schema;
  const props = asObj(s.properties);
  const required = asArr(s.required).filter((x): x is string => typeof x === "string");
  const out: Record<string, unknown> = {};
  for (const key of required.length ? required : Object.keys(props)) {
    const p = asObj(props[key]);
    const t = asStr(p.type);
    const fmt = asStr(p.format);
    if (fmt === "email") out[key] = "name@example.com";
    else if (t === "integer" || t === "number") out[key] = 1;
    else if (t === "boolean") out[key] = true;
    else if (t === "array") out[key] = [];
    else out[key] = key === "firstName" ? "Jane" : key === "lastName" ? "Doe" : "string";
  }
  return out;
}

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        });
      }}
      className="rounded-md border border-[#d8d2c4] bg-[#faf7f1] px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider text-[#6b6862] transition-colors hover:border-[#00aade] hover:text-[#00aade]"
    >
      {done ? "Copied" : label}
    </button>
  );
}

function TypeChip({ schema, spec }: { schema: JsonObj; spec: JsonObj }) {
  const ref = asStr(schema["$ref"]);
  const isRef = !!ref;
  return (
    <a
      href={isRef ? `#schema-${slug(typeLabel(schema, spec))}` : undefined}
      className={`inline-block rounded font-mono text-[12px] ${
        isRef
          ? "text-[#00819f] underline decoration-dotted underline-offset-2"
          : "text-[#8a6d3b]"
      }`}
    >
      {typeLabel(schema, spec)}
    </a>
  );
}

function EnumChips({ values }: { values: unknown[] }) {
  return (
    <span className="inline-flex flex-wrap gap-1 align-middle">
      {values.map((v, i) => (
        <code
          key={i}
          className="rounded border border-[#e6e1d6] bg-[#f3efe6] px-1.5 py-0.5 font-mono text-[11px] text-[#5a574f]"
        >
          {String(v)}
        </code>
      ))}
    </span>
  );
}

/**
 * Recursive property view. Renders an object schema's properties as rows;
 * nested objects / arrays-of-objects recurse (depth-capped). Resolves $ref.
 */
function SchemaView({
  schema,
  spec,
  depth = 0,
  required = [],
}: {
  schema: JsonObj;
  spec: JsonObj;
  depth?: number;
  required?: string[];
}) {
  const ref = asStr(schema["$ref"]);
  const s = ref ? resolveRef(ref, spec) : schema;
  const t = asStr(s.type);

  // Array → describe item shape.
  if (t === "array") {
    const items = asObj(s.items);
    return (
      <div>
        <p className="mb-2 font-mono text-[12px] text-[#6b6862]">
          array of <TypeChip schema={items} spec={spec} />
        </p>
        {depth < 5 && (asObj(items.properties) && Object.keys(asObj(items.properties)).length > 0 || asStr(items["$ref"])) ? (
          <div className="border-l-2 border-[#ece7da] pl-4">
            <SchemaView schema={items} spec={spec} depth={depth + 1} />
          </div>
        ) : null}
      </div>
    );
  }

  const props = asObj(s.properties);
  const keys = Object.keys(props);
  const req = required.length ? required : asArr(s.required).filter((x): x is string => typeof x === "string");

  if (keys.length === 0) {
    // Scalar / enum leaf.
    const en = asArr(s.enum);
    return (
      <p className="font-mono text-[12px] text-[#6b6862]">
        {typeLabel(s, spec)}
        {en.length > 0 ? <span className="ml-2"><EnumChips values={en} /></span> : null}
      </p>
    );
  }

  return (
    <div className="divide-y divide-[#efe9dc]">
      {keys.map((key) => {
        const p = asObj(props[key]);
        const pref = asStr(p["$ref"]);
        const resolved = pref ? resolveRef(pref, spec) : p;
        const en = asArr(p.enum);
        const nested =
          depth < 5 &&
          (asStr(resolved.type) === "object" ||
            Object.keys(asObj(resolved.properties)).length > 0 ||
            asStr(resolved.type) === "array");
        return (
          <div key={key} className="py-2.5">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <code className="font-mono text-[13px] font-semibold text-[#1c1b18]">{key}</code>
              <TypeChip schema={p} spec={spec} />
              {req.includes(key) ? (
                <span className="font-mono text-[10px] uppercase tracking-wider text-[#a3232c]">required</span>
              ) : null}
              {p.nullable === true ? (
                <span className="font-mono text-[10px] uppercase tracking-wider text-[#9b958a]">nullable</span>
              ) : null}
            </div>
            {asStr(p.description) ? (
              <p className="mt-1 text-[13px] leading-relaxed text-[#6b6862]">{asStr(p.description)}</p>
            ) : null}
            {en.length > 0 ? (
              <div className="mt-1.5">
                <EnumChips values={en} />
              </div>
            ) : null}
            {nested && !pref ? (
              <div className="mt-2 border-l-2 border-[#ece7da] pl-4">
                <SchemaView schema={resolved} spec={spec} depth={depth + 1} />
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function ParamTable({ params, spec }: { params: unknown[]; spec: JsonObj }) {
  if (params.length === 0) return null;
  return (
    <div>
      <h4 className="mb-2 font-mono text-[11px] uppercase tracking-[0.18em] text-[#9b958a]">Parameters</h4>
      <div className="divide-y divide-[#efe9dc] rounded-lg border border-[#e6e1d6] bg-white">
        {params.map((raw, i) => {
          const p = asObj(raw);
          const sch = asObj(p.schema);
          const en = asArr(sch.enum);
          return (
            <div key={i} className="px-4 py-3">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <code className="font-mono text-[13px] font-semibold text-[#1c1b18]">{asStr(p.name)}</code>
                <span className="font-mono text-[12px] text-[#8a6d3b]">{typeLabel(sch, spec)}</span>
                <span className="rounded bg-[#f3efe6] px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-[#9b958a]">
                  {asStr(p.in)}
                </span>
                {p.required === true ? (
                  <span className="font-mono text-[10px] uppercase tracking-wider text-[#a3232c]">required</span>
                ) : null}
              </div>
              {asStr(p.description) ? (
                <p className="mt-1 text-[13px] leading-relaxed text-[#6b6862]">{asStr(p.description)}</p>
              ) : null}
              {en.length > 0 ? (
                <div className="mt-1.5">
                  <EnumChips values={en} />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function bodySchemaOf(op: JsonObj): JsonObj | null {
  const rb = asObj(op.requestBody);
  const json = asObj(asObj(rb.content)["application/json"]);
  const sch = asObj(json.schema);
  return Object.keys(sch).length ? sch : null;
}

function responseSchemaOf(resp: JsonObj, spec: JsonObj): { schema: JsonObj | null; description?: string } {
  const ref = asStr(resp["$ref"]);
  const r = ref ? resolveRef(ref, spec) : resp;
  const json = asObj(asObj(r.content)["application/json"]);
  const sch = asObj(json.schema);
  return { schema: Object.keys(sch).length ? sch : null, description: asStr(r.description) };
}

function curlFor(method: string, path: string, op: JsonObj, baseUrl: string, spec: JsonObj): string {
  // Replace {placeholders} with sample ids; append example query params.
  const url = `${baseUrl}${path.replace(/\{(\w+)\}/g, (_, n) => `<${n}>`)}`;
  const lines = [`curl -H "x-api-key: mmg_your_key" \\`];
  const body = bodySchemaOf(op);
  if (method === "get") {
    lines.push(`  "${url}"`);
  } else {
    lines[0] = `curl -X ${method.toUpperCase()} \\`;
    lines.push(`  -H "x-api-key: mmg_your_key" \\`);
    lines.push(`  -H "Content-Type: application/json" \\`);
    if (body) {
      lines.push(`  -d '${JSON.stringify(sampleBody(body, spec))}' \\`);
    }
    lines.push(`  "${url}"`);
  }
  return lines.join("\n");
}

function Endpoint({
  path,
  method,
  op,
  spec,
  baseUrl,
}: {
  path: string;
  method: string;
  op: JsonObj;
  spec: JsonObj;
  baseUrl: string;
}) {
  const params = asArr(op.parameters);
  const body = bodySchemaOf(op);
  const responses = asObj(op.responses);
  const curl = curlFor(method, path, op, baseUrl, spec);

  return (
    <section id={opId(method, path)} className="scroll-mt-24 border-t border-[#e6e1d6] py-10 first:border-t-0">
      <div className="flex flex-wrap items-center gap-3">
        <span
          className={`rounded-md border px-2.5 py-1 font-mono text-[12px] font-bold uppercase tracking-wide ${METHOD_STYLE[method] ?? "text-[#5a574f] bg-[#f3efe6] border-[#e6e1d6]"}`}
        >
          {method}
        </span>
        <code className="font-mono text-[15px] text-[#1c1b18]">{path}</code>
      </div>
      <h3 className="api-display mt-4 text-[22px] leading-tight text-[#1c1b18]">{asStr(op.summary)}</h3>
      {asStr(op.description) ? (
        <p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-[#5a574f]">{asStr(op.description)}</p>
      ) : null}

      <div className="mt-6 grid gap-8 lg:grid-cols-[1fr_minmax(280px,420px)]">
        {/* Left: params + body + responses */}
        <div className="space-y-6">
          <ParamTable params={params} spec={spec} />

          {body ? (
            <div>
              <h4 className="mb-2 font-mono text-[11px] uppercase tracking-[0.18em] text-[#9b958a]">Request body</h4>
              <div className="rounded-lg border border-[#e6e1d6] bg-white px-4 py-3">
                <SchemaView schema={body} spec={spec} />
              </div>
            </div>
          ) : null}

          <div>
            <h4 className="mb-2 font-mono text-[11px] uppercase tracking-[0.18em] text-[#9b958a]">Responses</h4>
            <div className="space-y-3">
              {Object.keys(responses).map((code) => {
                const { schema, description } = responseSchemaOf(asObj(responses[code]), spec);
                const ok = code.startsWith("2");
                return (
                  <div key={code} className="rounded-lg border border-[#e6e1d6] bg-white">
                    <div className="flex items-center gap-3 border-b border-[#efe9dc] px-4 py-2.5">
                      <span
                        className={`font-mono text-[13px] font-bold ${ok ? "text-[#0a7d4d]" : "text-[#a3232c]"}`}
                      >
                        {code}
                      </span>
                      <span className="text-[13px] text-[#6b6862]">{description}</span>
                    </div>
                    {schema ? (
                      <div className="px-4 py-3">
                        <SchemaView schema={schema} spec={spec} />
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Right: curl sample (sticky) */}
        <div className="lg:sticky lg:top-24 lg:self-start">
          <div className="overflow-hidden rounded-lg border border-[#2a2926] bg-[#1c1b18]">
            <div className="flex items-center justify-between border-b border-[#34322d] px-3 py-2">
              <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#8b8678]">cURL</span>
              <CopyButton text={curl} />
            </div>
            <pre className="overflow-x-auto px-4 py-3 font-mono text-[12.5px] leading-relaxed text-[#e9e4d6]">
              <code>{curl}</code>
            </pre>
          </div>
        </div>
      </div>
    </section>
  );
}

interface NavOp {
  method: string;
  path: string;
  summary: string;
}

export function ApiReference({ spec, baseUrl }: { spec: JsonObj; baseUrl: string }) {
  const info = asObj(spec.info);
  const tags = asArr(spec.tags).map(asObj);
  const paths = asObj(spec.paths);
  const components = asObj(spec.components);
  const securitySchemes = asObj(components.securitySchemes);
  const schemas = asObj(components.schemas);

  // Group operations by tag (in declared tag order).
  const opsByTag = new Map<string, NavOp[]>();
  for (const path of Object.keys(paths)) {
    const item = asObj(paths[path]);
    for (const method of METHODS) {
      const op = asObj(item[method]);
      if (Object.keys(op).length === 0) continue;
      const tag = asStr(asArr(op.tags)[0]) ?? "Other";
      if (!opsByTag.has(tag)) opsByTag.set(tag, []);
      opsByTag.get(tag)!.push({ method, path, summary: asStr(op.summary) ?? path });
    }
  }
  const orderedTags = [
    ...tags.map((t) => asStr(t.name) ?? "").filter((n) => opsByTag.has(n)),
    ...[...opsByTag.keys()].filter((t) => !tags.some((tg) => asStr(tg.name) === t)),
  ];

  return (
    <div
      className="min-h-screen bg-[#faf7f1] text-[#1c1b18]"
      style={{ fontFamily: "var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif" }}
    >
      {/* Scoped: the serif display face for headings. */}
      <style>{`.api-display{font-family:var(--font-api-display),Georgia,'Times New Roman',serif;font-weight:500;letter-spacing:-0.01em;}`}</style>

      <div className="mx-auto flex max-w-[1240px] gap-10 px-6 lg:px-10">
        {/* Sidebar */}
        <aside className="sticky top-0 hidden h-screen w-60 shrink-0 overflow-y-auto py-10 lg:block">
          <a href="#top" className="api-display block text-[19px] leading-tight text-[#1c1b18]">
            {asStr(info.title) ?? "API"}
          </a>
          <p className="mt-1 font-mono text-[11px] text-[#9b958a]">v{asStr(info.version) ?? "1.0.0"}</p>

          <nav className="mt-8 space-y-6 text-[13px]">
            <div className="space-y-1.5">
              <a href="#overview" className="block text-[#5a574f] hover:text-[#00aade]">Overview</a>
              <a href="#authentication" className="block text-[#5a574f] hover:text-[#00aade]">Authentication</a>
            </div>
            {orderedTags.map((tag) => (
              <div key={tag}>
                <p className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-[#bdb6a6]">{tag}</p>
                <ul className="space-y-1.5">
                  {opsByTag.get(tag)!.map((o) => (
                    <li key={`${o.method}-${o.path}`}>
                      <a
                        href={`#${opId(o.method, o.path)}`}
                        className="flex items-center gap-2 text-[#5a574f] hover:text-[#00aade]"
                      >
                        <span
                          className={`shrink-0 rounded px-1 font-mono text-[9px] font-bold uppercase ${METHOD_STYLE[o.method] ?? ""}`}
                        >
                          {o.method}
                        </span>
                        <span className="truncate">{o.summary}</span>
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            <div>
              <p className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-[#bdb6a6]">Schemas</p>
              <ul className="space-y-1.5">
                {Object.keys(schemas).map((name) => (
                  <li key={name}>
                    <a href={`#schema-${slug(name)}`} className="block truncate text-[#5a574f] hover:text-[#00aade]">
                      {name}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          </nav>
        </aside>

        {/* Content */}
        <main id="top" className="min-w-0 flex-1 py-12 lg:py-16">
          {/* Hero / overview */}
          <section id="overview" className="scroll-mt-24">
            <p className="font-mono text-[12px] uppercase tracking-[0.2em] text-[#00aade]">REST API · OpenAPI 3.1</p>
            <h1 className="api-display mt-3 text-[clamp(34px,5vw,52px)] leading-[1.05] text-[#1c1b18]">
              {asStr(info.title) ?? "API Reference"}
            </h1>
            {asStr(info.description) ? (
              <div className="mt-5 max-w-2xl space-y-3 text-[15px] leading-relaxed text-[#4a473f]">
                {asStr(info.description)!
                  .split("\n")
                  .filter((l) => l.trim() && !l.trim().startsWith("#") && !l.trim().startsWith("```"))
                  .slice(0, 4)
                  .map((l, i) => (
                    <p key={i}>{l.replace(/\*\*/g, "").replace(/`/g, "")}</p>
                  ))}
              </div>
            ) : null}

            <div className="mt-7 inline-flex items-center gap-3 rounded-lg border border-[#e6e1d6] bg-white px-4 py-2.5">
              <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#9b958a]">Base URL</span>
              <code className="font-mono text-[13px] text-[#1c1b18]">{baseUrl}</code>
              <CopyButton text={baseUrl} />
            </div>
            <div className="mt-3">
              <a
                href="/api/openapi.json"
                className="font-mono text-[12px] text-[#00819f] underline decoration-dotted underline-offset-2 hover:text-[#00aade]"
              >
                openapi.json ↗
              </a>
            </div>
          </section>

          {/* Authentication */}
          <section id="authentication" className="mt-16 scroll-mt-24 border-t border-[#e6e1d6] pt-12">
            <h2 className="api-display text-[28px] text-[#1c1b18]">Authentication</h2>
            <p className="mt-3 max-w-2xl text-[14px] leading-relaxed text-[#5a574f]">
              Every request needs an organization API key. Create one in the dashboard under{" "}
              <strong className="text-[#1c1b18]">Settings → API Keys</strong> (shown once, prefixed{" "}
              <code className="rounded bg-[#f3efe6] px-1 font-mono text-[12px]">mmg_</code>). Send it on each request
              using either scheme below. Viewing these docs is public; calling an endpoint requires a key.
            </p>
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              {Object.keys(securitySchemes).map((name) => {
                const sc = asObj(securitySchemes[name]);
                const header =
                  asStr(sc.type) === "apiKey"
                    ? `${asStr(sc.name)}: mmg_your_key`
                    : `Authorization: Bearer mmg_your_key`;
                return (
                  <div key={name} className="rounded-lg border border-[#e6e1d6] bg-white p-4">
                    <p className="font-mono text-[13px] font-semibold text-[#1c1b18]">{name}</p>
                    {asStr(sc.description) ? (
                      <p className="mt-1 text-[13px] leading-relaxed text-[#6b6862]">{asStr(sc.description)}</p>
                    ) : null}
                    <div className="mt-3 flex items-center justify-between gap-2 rounded-md bg-[#1c1b18] px-3 py-2">
                      <code className="overflow-x-auto font-mono text-[12px] text-[#e9e4d6]">{header}</code>
                      <CopyButton text={header} />
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          {/* Endpoints grouped by tag */}
          {orderedTags.map((tag) => {
            const tagMeta = tags.find((t) => asStr(t.name) === tag);
            return (
              <section key={tag} id={`tag-${slug(tag)}`} className="mt-16 scroll-mt-24 border-t border-[#e6e1d6] pt-12">
                <h2 className="api-display text-[28px] text-[#1c1b18]">{tag}</h2>
                {tagMeta && asStr(tagMeta.description) ? (
                  <p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-[#5a574f]">
                    {asStr(tagMeta.description)}
                  </p>
                ) : null}
                <div className="mt-2">
                  {opsByTag.get(tag)!.map((o) => (
                    <Endpoint
                      key={`${o.method}-${o.path}`}
                      path={o.path}
                      method={o.method}
                      op={asObj(asObj(paths[o.path])[o.method])}
                      spec={spec}
                      baseUrl={baseUrl}
                    />
                  ))}
                </div>
              </section>
            );
          })}

          {/* Schemas */}
          <section className="mt-16 scroll-mt-24 border-t border-[#e6e1d6] pt-12">
            <h2 className="api-display text-[28px] text-[#1c1b18]">Schemas</h2>
            <div className="mt-2">
              {Object.keys(schemas).map((name) => (
                <div
                  key={name}
                  id={`schema-${slug(name)}`}
                  className="scroll-mt-24 border-t border-[#e6e1d6] py-8 first:border-t-0"
                >
                  <h3 className="font-mono text-[16px] font-semibold text-[#1c1b18]">{name}</h3>
                  {asStr(asObj(schemas[name]).description) ? (
                    <p className="mt-1 text-[13px] text-[#6b6862]">{asStr(asObj(schemas[name]).description)}</p>
                  ) : null}
                  <div className="mt-3 rounded-lg border border-[#e6e1d6] bg-white px-4 py-3">
                    <SchemaView schema={asObj(schemas[name])} spec={spec} />
                  </div>
                </div>
              ))}
            </div>
          </section>

          <footer className="mt-20 border-t border-[#e6e1d6] pt-8 text-[13px] text-[#9b958a]">
            <p>
              {asStr(info.title) ?? "EA-SYS API"} · v{asStr(info.version) ?? "1.0.0"} ·{" "}
              <a href="/api/openapi.json" className="text-[#00819f] underline decoration-dotted underline-offset-2">
                OpenAPI spec
              </a>
            </p>
          </footer>
        </main>
      </div>
    </div>
  );
}
