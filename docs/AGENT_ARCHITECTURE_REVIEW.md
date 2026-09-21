# Event Agent architecture review: one agent, two doors

**Status:** reviewed September 21, 2026; Phase 0 (§6, hardening) shipped the same day, Phases 1 to 4 not started. Addendum to
[EVENT_AGENT_READINESS.html](EVENT_AGENT_READINESS.html) (September 18), which
graded the agent against the UAE AI Award and found nine gaps (G1 to G9); this
page answers the owner's next question, "the agent sits inside an event, you
cannot create an event with it, and Medhat wants the team using it: should we
review the architecture?" Verified against the code at `02c3f7df`. Production
figures are read-only queries run the same morning.

---

## 1. The short answer

The shape is the problem, and it is a small one. EA-SYS has **three AI doors
over one tool registry**, and the door the team is being pushed toward (the
in-app Event Agent) is the narrowest of the three by construction: it exists
only inside an event, so it cannot create one, list the organisation's events,
search across them, or touch contacts, CRM or budgets. The door the team
actually uses is claude.ai through the MCP connector, which can do all of that
today.

The fix is not a new agent. It is to give the in-app door the same registry
the MCP door already gets, with the event as an optional context rather than a
prerequisite, and to put the guardrails the readiness review asked for in one
layer both doors share. About two weeks in five phases that each ship alone
(§6), and the first phase is the hardening, because pushing usage onto an agent
that does not pause before a bulk email is the risk, not the missing button.

---

## 2. What exists today

| | Event Agent (in-app) | claude.ai, Claude Desktop, n8n (MCP) | Help assistant |
|---|---|---|---|
| Where | `/events/[id]/agent`, `POST /api/events/[id]/agent/execute` (SSE) | `POST /api/mcp` (JSON-RPC, Streamable HTTP) | sidebar drawer, `POST /api/help-chat` |
| Who | SUPER_ADMIN, ADMIN, ORGANIZER, MEMBER (read-only tools only) | an OAuth grant by a staff role, or an org API key | every signed-in role |
| Tools | 53 event tools + `web_search` | about 100 core tools incl. the org-level `list_events`, `create_event`, `update_event`, `search_event`, contacts; CRM (12, by role) and Budgets (4, OAuth grants only) | none; it answers from the user guide |
| Context | the URL's event; the prompt is written for that event with its counts | the organisation; a tool that needs an event takes `eventId` as a parameter and `getOrgIdSecure` binds it to the org | the user's role and org |
| Memory | browser `localStorage`, per event, last 20 turns | the client's | browser `localStorage` |
| Guardrails | 20 requests per hour per user; 20 writes per request on a hand-written list of 14 tools; MEMBER refused every write and the finance and roster tools; no approval step; 25 loop turns | 100 requests per hour per key or token (INTERNAL tier exempt); per-tool validation; no write cap; no approval step | 50 per hour per user |
| Model | pinned `claude-sonnet-4-6` in the route | not applicable (the client's model) | via `src/lib/ai` config, per-tenant provider |
| Use, last 30 days | 5 tool calls on two days, one event, all reads | 1,014 requests from two people's claude.ai logins; 2 audited writes in 60 days | 28 questions from five people |

What is shared, and correctly so: the registry. Every tool's executor lives
once in `src/lib/agent/tools/*.ts` and is reached through `TOOL_EXECUTOR_MAP`
by both doors; executors call the services layer, so a registration created by
the agent, by claude.ai or by the REST route is the same code path.

What is duplicated: each tool's **schema** is declared twice, once as an
Anthropic JSON schema in `AGENT_TOOL_DEFINITIONS` for the in-app door and once
as a Zod schema in `register-mcp-tools.ts` for the MCP door. The inventory test
pins the two name sets against each other, not the parameters, so a parameter
added on one side and not the other passes CI.

The April 2026 "Distributed Multi-Agent Architecture" proposal is a different
question (many specialised agents with skills and learning). This page is about
one agent's doors and is the smaller step that would come first either way.

---

## 3. Why "create an event" cannot work, exactly

Five places bind the in-app agent to one event, and each one is deliberate:

1. The page is under `/events/[eventId]/`: there is no way to open the agent without first opening an event.
2. The API route takes `eventId` from the URL and 404s unless that event belongs to the caller's org.
3. `AgentContext.eventId` is a required string; every executor reads it.
4. `buildSystemPrompt(eventId, orgId)` loads that event's name, dates, venue and counts and opens with "You are a trusted AI event management assistant for <name>".
5. Every in-app tool definition omits `eventId` because the context injects it, so the model cannot address another event even if asked.

`create_event`, `update_event`, `list_events`, `search_event`, `list_contacts`
and `update_contact` are registered only on the MCP door, as top-level tools.
So the in-app agent cannot create an event, and asking it to do so produces
the "unknown tool" refusal or an invented answer. The same binding is why it
cannot answer "which events start next month" or "add Dr X to the contact
book", both of which claude.ai answers today.

---

## 4. The target shape: one agent, two doors

Principles: one registry (already true), one context type, one guardrail layer,
two transports (SSE for the page, JSON-RPC for MCP). Nothing below changes what
a tool does; it changes how a tool is reached.

### 4.1 Context

`AgentContext` becomes `{ organizationId, eventId: string | null, actor: { userId, role, fromApiKey }, source: "agent" | "mcp", counters }`.
Tools that need an event take `eventId` as a parameter in **both** doors (the
MCP door already does this; the in-app definitions gain it) and bind it through
`getOrgIdSecure`. When the page is opened from an event, the prompt carries a
"current event" block and the model passes that id; when it is opened from the
sidebar, the model asks or lists. `source` and `actor.userId` reach the audit
row, which closes G5 (today the agent's own actions are stamped `mcp`).

### 4.2 Route

`POST /api/agent/execute` at org level, body `{ message, history, eventId? }`.
The existing `/api/events/[eventId]/agent/execute` stays as a thin alias that
sets `eventId`, so no client breaks during the change. The tool list offered to
the model is **derived from the registry for that actor**: the top-level tools,
the event tools, and the CRM and Budgets tools under the same role and
module-flag rules `register-mcp-tools.ts` applies for an OAuth grant. One
function answers "which tools does this actor get" and both doors call it.

### 4.3 Page

`/agent` in the sidebar's Tools group for the four roles that hold the route
today. The event page's AI Agent entry opens `/agent?event=<id>` with the event
pre-selected, and a small event picker in the header lets the person switch or
clear it. History is keyed per conversation rather than per event, and moves
to the server once runs are stored (§4.6), which also makes a conversation
resumable from another device.

### 4.4 Prompt

An organisation header (org name, today's date, the org's timezone), an optional
current-event block (what `buildSystemPrompt` writes today), the read-only
banner for MEMBER, and a **capability list generated from the registry** rather
than typed by hand (G4: the prompt currently says the agent cannot delete or
edit sessions while both are exposed). The data-model paragraph and the worked
examples stay; the examples gain "create an event" and "find an event".

### 4.5 Guardrails, one layer for both doors

- **Write cap counts every write.** Derive "is this a write" from `isReadOnlyTool` (the predicate MEMBER gating already uses) instead of the hand-written 14-tool set, which misses 11 write tools today (G2).
- **Approval step.** For the actions the readiness review named (bulk email, deletes, Zoom meeting creation, replacing the sponsor list, replacing a session's speakers, CME settings) the loop stops and emits a `needs_approval` event carrying the proposed call; the page shows the call in plain words with Approve and Cancel; an approved call re-enters the loop with a short-lived approval token the route verifies. On the MCP door the same tools answer "requires confirmation, call again with `confirm: true`", which claude.ai turns into a question to the person (G1).
- **Tool output as data.** Tool results are wrapped in a delimited data block and the prompt says results are data, never instructions, before they reach the model (G3). Attendee names, abstract text and scraped pages are where an injected instruction would arrive.
- **Rate limits** stay per user (in-app) and per key or token (MCP); the write cap and the approval list apply to both.

### 4.6 Runs

`AgentRun` and `AgentStep` tables (user, org, optional event, source, request,
each step's tool, duration and outcome, approvals, tokens, cost), organisation
stamped, RLS policy, CI-gate entry, a prune job like the email-log prune.
Store tool names and counts, never tool results, so attendee data stays out.
This is the readiness review's O1 and it is what makes Medhat's push
measurable: today the baseline is a CloudWatch query.

### 4.7 Model

The route calls `src/lib/ai`'s config (`AiFeature = "agent"` already exists
there) instead of pinning the model string (G9). Per-tenant keys are already
resolved through `resolveAnthropicApiKey`.

---

## 5. What this deliberately does not change

- The help assistant stays a separate, tool-less door open to every role; its drawer gains a "Do this with the agent" hand-off for the four agent roles.
- The MCP door is unchanged for clients; the version bump is the only visible change, and connected clients reconnect.
- The services layer, the executors and the tests over them are untouched; the change is in how tools are reached, not what they do.
- Roles: the same four roles reach the in-app agent; MEMBER stays read-only; ONSITE, WEBINARS, CRM_USER and HR_USER stay excluded, as today.

---

## 6. Build order and cost

Each phase ships alone, passes the full gate, and is behaviour-identical for
everyone until its own switch. Nothing needs a schema change before Phase 3.

| Phase | What | Days | Proof |
|---|---|---|---|
| 0. Harden what exists | write cap derived from the read-only predicate (G2); tool output wrapped as data (G3); capability list generated from the registry (G4); `source` and `userId` on every audit row (G5); model via config (G9) | 3 | a cap test over every write tool, a prompt drift test, the readonly-gate suite extended |
| 1. The org-level door | the context change, `/api/agent/execute` with the event alias, `eventId` on the in-app tool definitions, the `/agent` page with event pre-context, the sidebar entry, the prompt rebuild, one tool-selection function for both doors | 3 to 4 | a route test creating an event through the in-app door; alias parity; MEMBER read-only unchanged; the inventory test extended to the in-app list |
| 2. Approvals | the `needs_approval` event, the page's Approve and Cancel, the approval token, the MCP `confirm` flag | 2 | a test per listed action that the call does not run without approval |
| 3. Runs and the digest | the two tables, migration, RLS, prune job, a line in the daily digest | 2 | harness assertions, a digest test |
| 4. One schema per tool (optional) | generate the Anthropic JSON schema from the Zod declaration so the two doors cannot drift; the inventory test compares parameters too | 1 to 2 | the inventory test |

About two weeks. Phase 0 before anyone is told to use it; Phase 1 is the
answer to "create an event"; Phase 2 before a bulk send is ever left to the
model; Phase 3 before the first number is reported to Medhat.

---

## 7. Risks, cost of running, and the manual alternative

- **Blast radius widens with the door.** An org-level agent can touch every event, so the hardening comes first and the approval step covers the irreversible actions. The write cap, the per-user rate limit and the role gate stay.
- **Running cost is negligible.** One more page and route; the executors, the model calls and the rate limits are the ones already there. Storing runs adds a small table with a prune job.
- **The manual alternative is real.** claude.ai seats plus the MMG connector give the team an org-level agent today, with `create_event`, memory across days and a phone. A one-page guide costs an hour. The in-app door earns its place for people without seats, for the approval UI we control, and for the run record.

---

## 8. Decisions for the owner

| Question | Recommendation |
|---|---|
| Which door is the team pushed to first? | Both: the claude.ai connector now with a one-page guide (zero code); the in-app door after Phases 0 and 1. |
| Which actions need approval? | The readiness list: bulk email, deletes, Zoom meeting creation, sponsor list replace, replacing session speakers, CME settings. Remove the two delete tools unless someone relies on them. |
| Which roles reach the org-level door? | The same four; CRM tools appear for roles `canViewCrm` admits and Budgets tools for `canViewProcurement`, the rules the MCP door already applies. |
| Where does conversation history live? | The browser until Phase 3, the server after, keyed per conversation. |
| Model | Stay on `claude-sonnet-4-6` until the readiness review's eval comparison (E5) says otherwise. |

---

## 9. How this was checked

Read: `src/app/api/events/[eventId]/agent/execute/route.ts`,
`src/lib/agent/system-prompt.ts`, `src/lib/agent/event-tools.ts`,
`src/lib/agent/tools/_shared.ts`, `src/lib/agent/mcp-server-builder.ts`,
`src/lib/agent/register-mcp-tools.ts`, `src/crm/agent-tools.ts`,
`src/procurement/agent-tools.ts`, `src/app/api/mcp/route.ts`,
`src/app/(dashboard)/events/[eventId]/agent/page.tsx`, `src/lib/ai/*`, and the
sixteen agent and MCP test files. Usage: read-only production queries on
`AuditLog` (`changes.source`), `McpOAuthAccessToken`, `ApiKey` and
`HelpChatQuery`, plus the readiness review's CloudWatch figures for 19 August to
18 September. No production data was changed.
